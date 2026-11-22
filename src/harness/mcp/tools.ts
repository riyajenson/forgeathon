// MCP tool handlers. Transport-free so they can be tested directly and reused by the turn controller.
import { Worker } from 'node:worker_threads';
import type { ApplyTextResult } from '../contract-types';
import { capLine, isBinaryText, LIST_LIMIT, modelPathRefusal, visibleFiles } from '../context/files';
import { applyAccepted, canonicalArgsKey, computeProposal, normalizeEdits, sha256Hex, type ProposalHunk, type SearchReplaceEdit } from '../review';
import { normalizeWorkspacePath } from './paths';
import type { EditorPort } from './port';
import type { SessionScope } from './scope';

export type ToolErrorCode =
  | 'INVALID_ARGS'
  | 'OUTSIDE_WORKSPACE'
  | 'SECRET_FILE'
  | 'BINARY_FILE'
  | 'POLICY_UNAVAILABLE'
  | 'TIMEOUT'
  | 'FILE_NOT_FOUND'
  | 'STALE_BASE'
  | 'NO_REVIEW_DECISION'
  | 'CANCELLED'
  | 'OLD_TEXT_NOT_FOUND'
  | 'OLD_TEXT_AMBIGUOUS'
  | 'OVERLAPPING_EDITS'
  | 'INVALID_EDIT'
  | 'ALL_HUNKS_REJECTED'
  | 'WRITE_FAILED'
  | 'WRITE_OUTCOME_UNKNOWN';

export type ToolOutcome = { ok: true; text: string } | { ok: false; code: ToolErrorCode; message: string };

export interface ToolContext {
  port: EditorPort;
  /** Scope of the TrueForge session that made the call; undefined when the call carries no known session. */
  scope: SessionScope | undefined;
  /** Mask credential-shaped strings in tool output before it reaches the model (default true; see maskSourceSecrets). */
  maskSecrets?: boolean | undefined;
}

export interface ProposeEditArgs {
  path: string;
  base_sha256: string;
  edits: SearchReplaceEdit[];
  summary?: string | undefined;
}

const fail = (code: ToolErrorCode, message: string): ToolOutcome => ({ ok: false, code, message });

export const hunkId = (proposalId: string, index: number): string => `${proposalId}#${index}`;

/**
 * Key that binds a user's approval to the tool call that executes it. Only the tool's declared fields are
 * hashed, because the MCP server strips undeclared keys before the handler sees the arguments, while the
 * turn controller sees the model's raw arguments.
 */
export function approvalKey(tool: 'propose_edit' | 'run_command', args: unknown): string {
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
  if (tool === 'propose_edit') {
    const raw = normalizeEdits(a['edits']);
    const edits = Array.isArray(raw)
      ? raw.map((e) => {
        const x = (e && typeof e === 'object' ? e : {}) as Record<string, unknown>;
        return { old_text: x['old_text'], new_text: x['new_text'] };
      })
      : raw;
    return canonicalArgsKey({ path: a['path'], base_sha256: a['base_sha256'], edits, summary: a['summary'] });
  }
  return canonicalArgsKey({ command: a['command'], cwd: a['cwd'], timeout_sec: a['timeout_sec'] });
}

// ---------------------------------------------------------------- read_file

export const READ_FILE_MAX_LINES = 600;
/** Characters of file content per read_file call; the rest is offered with start_line. */
export const READ_FILE_MAX_CHARS = 60_000;

export interface ReadFileArgs {
  path: string;
  start_line?: number | undefined;
  end_line?: number | undefined;
}

export async function readFileTool(ctx: ToolContext, args: ReadFileArgs): Promise<ToolOutcome> {
  const path = normalizeWorkspacePath(args.path);
  if (!path) return fail('OUTSIDE_WORKSPACE', `path must be workspace-relative: ${String(args.path)}`);
  const refusal = modelPathRefusal(path);
  if (refusal) return fail('SECRET_FILE', refusal);
  const snap = await ctx.port.readText(path);
  if (!snap) return fail('FILE_NOT_FOUND', `${path} does not exist`);
  if (isBinaryText(snap.text)) return fail('BINARY_FILE', `${path} contains NUL bytes (binary); it is not sent to the model`);

  const lines = snap.text.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const total = lines.length;
  const start = Math.max(1, Math.floor(args.start_line ?? 1));
  const requestedEnd = Math.floor(args.end_line ?? total);
  let end = Math.min(total, requestedEnd, start + READ_FILE_MAX_LINES - 1);
  const width = String(end).length;
  const shown: string[] = [];
  let chars = 0;
  let charCut = false;
  for (let n = start; n <= end; n++) {
    const line = `${String(n).padStart(width)}\t${capLine(lines[n - 1]!)}`;
    if (shown.length && chars + line.length + 1 > READ_FILE_MAX_CHARS) { end = n - 1; charCut = true; break; }
    shown.push(line);
    chars += line.length + 1;
  }
  const body = start > total ? '' : shown.join('\n');
  const more = charCut
    ? `\n[truncated at ${READ_FILE_MAX_CHARS} characters: call read_file with start_line=${end + 1} for more]`
    : end < Math.min(total, requestedEnd) || (args.end_line === undefined && end < total)
      ? `\n[truncated: call read_file with start_line=${end + 1} for more]`
      : '';
  return {
    ok: true,
    text: `path: ${path}\nsha256: ${snap.sha256}\nlines: ${total} (showing ${start}-${end})\n---\n${body}${more}`,
  };
}

// ---------------------------------------------------------------- search_workspace

export const SEARCH_MAX_FILE_CHARS = 1_000_000;
/** Characters of search results per call. */
export const SEARCH_MAX_OUTPUT_CHARS = 40_000;

/** A .gitignore that exists but cannot be read: which files it excludes is unknown, so nothing is listed. */
export function unreadableIgnores(paths: string[]): ToolOutcome {
  return fail('POLICY_UNAVAILABLE', `cannot read ${paths.join(', ')}; files it may exclude are unknown, so nothing is listed or searched until it can be read`);
}

export interface SearchArgs {
  query: string;
  regex?: boolean | undefined;
  case_sensitive?: boolean | undefined;
  path_prefix?: string | undefined;
  max_results?: number | undefined;
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
  const source = args.regex ? args.query : args.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const flags = args.case_sensitive ? '' : 'i';
  try {
    new RegExp(source, flags);
  } catch (e) {
    return fail('INVALID_ARGS', `invalid regex: ${(e as Error).message}`);
  }

  const files: SearchFile[] = [];
  const visible = await visibleFiles(ctx.port, prefix);
  if (visible.unreadableIgnores.length) return unreadableIgnores(visible.unreadableIgnores);
  let notText = 0;
  for (const path of visible.files) {
    const snap = await ctx.port.readText(path).catch(() => null);
    if (!snap) continue;
    if (snap.text.length > SEARCH_MAX_FILE_CHARS || isBinaryText(snap.text)) { notText++; continue; }
    files.push({ path, text: snap.text });
  }
  // A model-supplied regex can backtrack for minutes, so it runs in a worker thread that is terminated at the
  // deadline. A plain-text pattern is linear, but over a large workspace it still takes long enough to stall
  // the editor's extension host, so it also moves to the worker above SEARCH_INLINE_MAX_CHARS.
  const totalChars = files.reduce((n, f) => n + f.text.length, 0);
  const found = args.regex || totalChars > SEARCH_INLINE_MAX_CHARS
    ? await matchInWorker(files, source, flags, max)
    : matchFiles(files, source, flags, max);
  if (!found) {
    return fail('TIMEOUT', `regex search stopped after ${SEARCH_REGEX_TIMEOUT_MS / 1000} s (the pattern backtracks too much); use a simpler pattern or regex=false`);
  }
  const header = `${found.hits.length} match(es) in ${found.filesWithHits} file(s) for ${args.regex ? 'regex' : 'text'} ${JSON.stringify(args.query)}${prefix ? ` under ${prefix}` : ''}`;
  const partial = visible.truncated ? ` [only the first ${LIST_LIMIT} workspace files were searched]` : '';
  const skippedNote = notText ? ` [${notText} binary or oversized file(s) not searched]` : '';
  let body = '';
  let cut = 0;
  for (const [i, hit] of found.hits.entries()) {
    if (body.length + hit.length + 1 > SEARCH_MAX_OUTPUT_CHARS) { cut = found.hits.length - i; break; }
    body += `${body ? '\n' : ''}${hit}`;
  }
  const outputCut = cut ? `\n[output truncated at ${SEARCH_MAX_OUTPUT_CHARS} characters: ${cut} more match(es); narrow the query or use path_prefix]` : '';
  return { ok: true, text: `${header}${found.truncated ? ` [truncated at ${max}]` : ''}${partial}${skippedNote}\n${body}${outputCut}` };
}

export const SEARCH_REGEX_TIMEOUT_MS = 2000;
/** Plain-text searches over more text than this run in the worker instead of on the editor's thread. */
export const SEARCH_INLINE_MAX_CHARS = 2_000_000;

interface SearchFile { path: string; text: string }
interface SearchResult { hits: string[]; filesWithHits: number; truncated: boolean }

// Self-contained (no imports, no closures): its source text is also the worker's code.
function matchFiles(files: SearchFile[], source: string, flags: string, max: number): SearchResult {
  const pattern = new RegExp(source, flags);
  const hits: string[] = [];
  let filesWithHits = 0;
  for (const file of files) {
    const lines = file.text.split(/\r?\n/);
    let fileHit = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (!pattern.test(line)) continue;
      if (!fileHit) { filesWithHits++; fileHit = true; }
      if (hits.length >= max) return { hits, filesWithHits, truncated: true };
      hits.push(`${file.path}:${i + 1}: ${line.trim().slice(0, 200)}`);
    }
  }
  return { hits, filesWithHits, truncated: false };
}

const WORKER_SOURCE = `const { parentPort, workerData: d } = require('node:worker_threads');\n${matchFiles.toString()}\nparentPort.postMessage(matchFiles(d.files, d.source, d.flags, d.max));`;

/** Runs matchFiles in a worker thread; resolves null if it does not finish within SEARCH_REGEX_TIMEOUT_MS. */
function matchInWorker(files: SearchFile[], source: string, flags: string, max: number): Promise<SearchResult | null> {
  return new Promise((resolve) => {
    const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { files, source, flags, max } });
    const timer = setTimeout(() => { void worker.terminate(); resolve(null); }, SEARCH_REGEX_TIMEOUT_MS);
    worker.once('message', (r: SearchResult) => { clearTimeout(timer); void worker.terminate(); resolve(r); });
    worker.once('error', () => { clearTimeout(timer); resolve(null); });
  });
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

export type BuildResult = { ok: true; proposal: BuiltProposal } | { ok: false; code: ToolErrorCode; message: string };

/**
 * Validates propose_edit arguments against the current editor text and computes the hunks.
 * Used by the turn controller to build the review and by the tool to re-derive the same hunks at apply time.
 */
export async function buildProposal(port: EditorPort, args: ProposeEditArgs): Promise<BuildResult> {
  const path = normalizeWorkspacePath(args?.path);
  if (!path) return { ok: false, code: 'OUTSIDE_WORKSPACE', message: `path must be workspace-relative: ${String(args?.path)}` };
  if (typeof args.base_sha256 !== 'string') return { ok: false, code: 'INVALID_ARGS', message: 'base_sha256 must be a string ("" for a new file)' };
  const snap = await port.readText(path);
  if (snap && snap.sha256 !== args.base_sha256) {
    return { ok: false, code: 'STALE_BASE', message: `${path} changed since it was read (sha256 is now ${snap.sha256}); read it again` };
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

/** Outcomes after which the workspace may have changed. */
export function isWriteOutcome(result: ApplyTextResult): boolean {
  return result.status === 'buffer_applied' || result.status === 'save_failed' || result.status === 'saved';
}

/**
 * Applies the accepted hunks of a reviewed proposal. Never writes without a matching review decision in
 * the caller's session scope, never after cancellation, and never over a changed file.
 */
export async function proposeEditTool(ctx: ToolContext, args: ProposeEditArgs): Promise<ToolOutcome> {
  const scope = ctx.scope;
  if (!scope) return fail('NO_REVIEW_DECISION', 'this call is not bound to an active turn; nothing was written');
  if (scope.cancelled) return fail('CANCELLED', 'the turn was cancelled; nothing was written');
  const approval = scope.reviews.take(approvalKey('propose_edit', args));
  if (!approval) return fail('NO_REVIEW_DECISION', 'no recorded review decision for these exact arguments; nothing was written');

  const built = await buildProposal(ctx.port, args);
  if (!built.ok) return fail(built.code, built.message);
  const p = built.proposal;
  if (p.baseSha256 !== approval.baseSha256) return fail('STALE_BASE', `${p.path} changed after it was reviewed; nothing was written`);
  const [firstId, ...restIds] = approval.acceptedHunkIds;
  if (approval.acceptedIndices.length === 0 || firstId === undefined) {
    return fail('ALL_HUNKS_REJECTED', `the user rejected every hunk${approval.rejectReason ? `: ${approval.rejectReason}` : ''}`);
  }

  let outcome;
  try {
    outcome = applyAccepted(p.originalText, p.hunks, approval.acceptedIndices);
  } catch (e) {
    return fail('STALE_BASE', (e as Error).message);
  }
  if (scope.cancelled) return fail('CANCELLED', 'the turn was cancelled; nothing was written');

  let result: ApplyTextResult;
  try {
    result = await ctx.port.applyText({
      ...approval.callRef,
      kind: 'apply_approved',
      proposalId: approval.proposalId,
      acceptedHunkIds: [firstId, ...restIds],
      path: p.path,
      expectedSha256: p.baseSha256,
      text: outcome.text,
      textSha256: sha256Hex(outcome.text),
    });
  } catch (e) {
    scope.writes++;
    return fail('WRITE_OUTCOME_UNKNOWN', `the editor did not report an outcome for ${p.path} (${(e as Error).message}); re-read the file before continuing`);
  }
  if (isWriteOutcome(result)) scope.writes++;
  if (result.status === 'buffer_applied' || result.status === 'save_failed') scope.unsavedPaths.add(p.path);
  if (result.status === 'saved') scope.unsavedPaths.delete(p.path);
  scope.onApplied?.(result);

  const rejected = outcome.rejected.length
    ? ` Rejected hunks ${JSON.stringify(outcome.rejected)} were NOT applied${approval.rejectReason ? ` (user said: ${approval.rejectReason})` : ''}.`
    : '';
  const applied = `Applied hunks ${JSON.stringify(outcome.applied)} of ${p.hunks.length} to ${p.path}.${rejected}`;
  switch (result.status) {
    case 'stale':
      return fail('STALE_BASE', `${p.path} changed before it could be written; nothing was written. Read it again.`);
    case 'approval_missing':
      return fail('NO_REVIEW_DECISION', `the editor has no matching approval for ${p.path}; nothing was written`);
    case 'failed_before_apply':
      return fail('WRITE_FAILED', `${p.path} was not changed: ${result.message}`);
    case 'buffer_applied':
      return { ok: true, text: `${applied} The change is in the editor but NOT saved (${result.reason}); commands and tests will not see it. New sha256: ${result.undo.expectedPostSha256}` };
    case 'save_failed':
      return { ok: true, text: `${applied} The change is in the editor but saving failed (${result.message}); commands and tests will not see it. New sha256: ${result.currentBufferSha256}` };
    case 'saved': {
      const reformatted = result.savedTextSha256 !== sha256Hex(outcome.text);
      return {
        ok: true,
        text: `${applied} Saved. New sha256: ${result.savedTextSha256}${reformatted ? ' (the editor reformatted the file on save; read it again before editing it further)' : ''}`,
      };
    }
  }
}
