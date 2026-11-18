// MCP tool handlers. Transport-free so they can be tested directly and reused by the adapter.
import { applyAccepted, canonicalArgsKey, computeProposal, type ProposalHunk, type ReviewRegistry, type SearchReplaceEdit } from '../review';
import { normalizeWorkspacePath } from './paths';
import type { EditorPort } from './port';

export type ToolErrorCode =
  | 'INVALID_ARGS'
  | 'OUTSIDE_WORKSPACE'
  | 'FILE_NOT_FOUND'
  | 'STALE_BASE'
  | 'NO_REVIEW_DECISION'
  | 'CANCELLED'
  | 'OLD_TEXT_NOT_FOUND'
  | 'OLD_TEXT_AMBIGUOUS'
  | 'OVERLAPPING_EDITS'
  | 'INVALID_EDIT'
  | 'ALL_HUNKS_REJECTED'
  | 'WRITE_FAILED';

export type ToolOutcome = { ok: true; text: string } | { ok: false; code: ToolErrorCode; message: string };

/** A user's review of one propose_edit call, recorded by the adapter before it allows the call. */
export interface EditApproval {
  proposalId: string;
  /** sha256 of the text the user reviewed; null when the file is new. */
  baseSha256: string | null;
  /** Hunk indices (file order) the user accepted. */
  accepted: number[];
  rejectReason?: string;
}

export interface AppliedEdit {
  proposalId: string;
  path: string;
  isNewFile: boolean;
  preSha256: string | null;
  postSha256: string;
  /** Text before the write, so the editor can offer "Revert this turn". */
  preText: string | null;
  applied: number[];
  rejected: number[];
}

export interface ToolContext {
  port: EditorPort;
  reviews: ReviewRegistry<EditApproval>;
  /** True once the current turn is being cancelled; no write may start after that. */
  isCancelled(): boolean;
  onApplied?(edit: AppliedEdit): void;
}

export interface ProposeEditArgs {
  path: string;
  base_sha256: string;
  edits: SearchReplaceEdit[];
  summary?: string;
}

const fail = (code: ToolErrorCode, message: string): ToolOutcome => ({ ok: false, code, message });

// ---------------------------------------------------------------- read_file

export const READ_FILE_MAX_LINES = 600;

export interface ReadFileArgs {
  path: string;
  start_line?: number;
  end_line?: number;
}

export async function readFileTool(ctx: ToolContext, args: ReadFileArgs): Promise<ToolOutcome> {
  const path = normalizeWorkspacePath(args.path);
  if (!path) return fail('OUTSIDE_WORKSPACE', `path must be workspace-relative: ${String(args.path)}`);
  const snap = await ctx.port.readText(path);
  if (!snap) return fail('FILE_NOT_FOUND', `${path} does not exist`);

  const lines = snap.text.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const total = lines.length;
  const start = Math.max(1, Math.floor(args.start_line ?? 1));
  const requestedEnd = Math.floor(args.end_line ?? total);
  const end = Math.min(total, requestedEnd, start + READ_FILE_MAX_LINES - 1);
  const width = String(end).length;
  const body = start > total ? '' : lines.slice(start - 1, end).map((l, i) => `${String(start + i).padStart(width)}\t${l}`).join('\n');
  const more = end < Math.min(total, requestedEnd) || (args.end_line === undefined && end < total)
    ? `\n[truncated: call read_file with start_line=${end + 1} for more]`
    : '';
  return {
    ok: true,
    text: `path: ${path}\nsha256: ${snap.sha256}\nlines: ${total} (showing ${start}-${end})\n---\n${body}${more}`,
  };
}

// ---------------------------------------------------------------- search_workspace

export const SEARCH_MAX_FILE_CHARS = 1_000_000;

export interface SearchArgs {
  query: string;
  regex?: boolean;
  case_sensitive?: boolean;
  path_prefix?: string;
  max_results?: number;
}

export async function searchWorkspaceTool(ctx: ToolContext, args: SearchArgs): Promise<ToolOutcome> {
  if (typeof args.query !== 'string' || args.query === '') return fail('INVALID_ARGS', 'query must be a non-empty string');
  let prefix: string | undefined;
  if (args.path_prefix !== undefined && args.path_prefix !== '') {
    const p = normalizeWorkspacePath(args.path_prefix);
    if (!p) return fail('OUTSIDE_WORKSPACE', `path_prefix must be workspace-relative: ${args.path_prefix}`);
    prefix = p;
  }
  const max = Math.min(Math.max(1, Math.floor(args.max_results ?? 50)), 200);
  let pattern: RegExp;
  try {
    const source = args.regex ? args.query : args.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    pattern = new RegExp(source, args.case_sensitive ? '' : 'i');
  } catch (e) {
    return fail('INVALID_ARGS', `invalid regex: ${(e as Error).message}`);
  }

  const files = await ctx.port.listFiles(prefix ? { prefix } : undefined);
  const hits: string[] = [];
  let filesWithHits = 0;
  let truncated = false;
  outer: for (const file of files) {
    const snap = await ctx.port.readText(file);
    if (!snap || snap.text.length > SEARCH_MAX_FILE_CHARS || snap.text.includes('\0')) continue;
    const lines = snap.text.split(/\r?\n/);
    let fileHit = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (!pattern.test(line)) continue;
      if (!fileHit) { filesWithHits++; fileHit = true; }
      if (hits.length >= max) { truncated = true; break outer; }
      hits.push(`${file}:${i + 1}: ${line.trim().slice(0, 200)}`);
    }
  }
  const header = `${hits.length} match(es) in ${filesWithHits} file(s) for ${args.regex ? 'regex' : 'text'} ${JSON.stringify(args.query)}${prefix ? ` under ${prefix}` : ''}`;
  return { ok: true, text: `${header}${truncated ? ` [truncated at ${max}]` : ''}\n${hits.join('\n')}` };
}

// ---------------------------------------------------------------- propose_edit

export interface BuiltProposal {
  path: string;
  isNewFile: boolean;
  /** sha256 of the current text; null for a new file. */
  baseSha256: string | null;
  originalText: string;
  proposedText: string;
  hunks: ProposalHunk[];
  summary: string;
}

/**
 * Validates propose_edit arguments against the current editor text and computes the hunks.
 * Used by the adapter to build the review and by the tool to re-derive the same hunks at apply time.
 */
export async function buildProposal(port: EditorPort, args: ProposeEditArgs): Promise<{ ok: true; proposal: BuiltProposal } | { ok: false; code: ToolErrorCode; message: string }> {
  const path = normalizeWorkspacePath(args?.path);
  if (!path) return { ok: false, code: 'OUTSIDE_WORKSPACE', message: `path must be workspace-relative: ${String(args?.path)}` };
  if (typeof args.base_sha256 !== 'string') return { ok: false, code: 'INVALID_ARGS', message: 'base_sha256 must be a string ("" for a new file)' };
  const snap = await port.readText(path);
  if (snap && snap.sha256 !== args.base_sha256) {
    return { ok: false, code: 'STALE_BASE', message: `${path} changed since it was read (sha256 is ${snap.sha256}); read it again` };
  }
  if (!snap && args.base_sha256 !== '') {
    return { ok: false, code: 'FILE_NOT_FOUND', message: `${path} does not exist; use base_sha256 "" to create it` };
  }
  const computed = computeProposal(snap ? snap.text : null, args.edits);
  if (!computed.ok) return { ok: false, code: computed.code, message: computed.message };
  return {
    ok: true,
    proposal: {
      path,
      isNewFile: computed.isNewFile,
      baseSha256: snap ? snap.sha256 : null,
      originalText: snap ? snap.text : '',
      proposedText: computed.proposedText,
      hunks: computed.hunks,
      summary: typeof args.summary === 'string' ? args.summary : '',
    },
  };
}

/**
 * Applies the accepted hunks of a reviewed proposal. Never writes without a matching review decision,
 * never writes after cancellation, and never writes over a changed file.
 */
export async function proposeEditTool(ctx: ToolContext, args: ProposeEditArgs): Promise<ToolOutcome> {
  if (ctx.isCancelled()) return fail('CANCELLED', 'the turn was cancelled; nothing was written');
  const approval = ctx.reviews.take(canonicalArgsKey(args));
  if (!approval) return fail('NO_REVIEW_DECISION', 'no recorded review decision for these exact arguments; nothing was written');

  const built = await buildProposal(ctx.port, args);
  if (!built.ok) return fail(built.code, built.message);
  const p = built.proposal;
  if (p.baseSha256 !== approval.baseSha256) {
    return fail('STALE_BASE', `${p.path} changed after it was reviewed; nothing was written`);
  }
  if (approval.accepted.length === 0) {
    return fail('ALL_HUNKS_REJECTED', `the user rejected every hunk${approval.rejectReason ? `: ${approval.rejectReason}` : ''}`);
  }

  let outcome;
  try {
    outcome = applyAccepted(p.originalText, p.hunks, approval.accepted);
  } catch (e) {
    return fail('STALE_BASE', (e as Error).message);
  }
  if (ctx.isCancelled()) return fail('CANCELLED', 'the turn was cancelled; nothing was written');

  const write = await ctx.port.applyText({ path: p.path, expectedSha256: p.baseSha256, newText: outcome.text });
  if (!write.ok) return fail(write.code, write.message);

  ctx.onApplied?.({
    proposalId: approval.proposalId,
    path: p.path,
    isNewFile: p.isNewFile,
    preSha256: write.preSha256,
    postSha256: write.postSha256,
    preText: p.isNewFile ? null : p.originalText,
    applied: outcome.applied,
    rejected: outcome.rejected,
  });
  const rejectedNote = outcome.rejected.length
    ? ` Rejected hunks ${JSON.stringify(outcome.rejected)} were NOT applied${approval.rejectReason ? ` (user said: ${approval.rejectReason})` : ''}.`
    : '';
  return {
    ok: true,
    text: `Applied hunks ${JSON.stringify(outcome.applied)} of ${p.hunks.length} to ${p.path}.${rejectedNote} New sha256: ${write.postSha256}`,
  };
}
