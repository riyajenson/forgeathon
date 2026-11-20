// Context assembly: pinned items (selection, @symbol, @file, active file) first, then automatically
// retrieved outlines and whole functions, all within one token budget, with reasons for every choice.
import type { ContextReport, Reference, SourceRange } from '../contract-types';
import type { EditorPort } from '../mcp/port';
import { normalizeWorkspacePath } from '../mcp/paths';
import { rankFiles, shouldUseSemantic, type RankedFile } from './rank';
import { isBinaryText, isSecretPath, modelPathRefusal } from './files';
import { estimateTokens } from './text';
import { buildIndex, type IndexedChunk, type IndexedFile, type WorkspaceIndex } from './workspace-index';
import { LocalSemanticRanker } from './semantic';

export interface ContextRequest {
  instruction: string;
  selection?: SourceRange & { path: string; text: string };
  activeFile?: string;
  references?: readonly Reference[];
  budgetTokens: number;
  /** Enable selective local semantic reranking after lexical confidence is checked. */
  semanticSearch?: boolean;
  /** Stop semantic inference if the parent turn is cancelled. */
  signal?: AbortSignal;
  /** Inline edits pin the selection and add only a little automatic context. */
  mode: 'inline' | 'agent';
}

export interface ContextAssemblyOptions {
  /** Test or host injection; production calls share one lazy local model worker. */
  semanticRanker?: Pick<LocalSemanticRanker, 'rank'>;
}

export interface ContextResult {
  report: ContextReport;
  /** Markdown block to append to the model's input. */
  text: string;
  ranked: RankedFile[];
  ms: number;
}

type Selection = ContextReport['selections'][number];
type Skipped = ContextReport['skipped'][number];

const MAX_RANKED_FILES = 8;
const OUTLINE_FILES = 5;
const CHUNKS_PER_FILE = 3;
const MAX_CHUNK_SHARE = 0.15;
const MAX_SEMANTIC_FILES = 20;
const pathOrder = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
let sharedSemanticRanker: LocalSemanticRanker | undefined;

function defaultSemanticRanker(): LocalSemanticRanker {
  return sharedSemanticRanker ??= new LocalSemanticRanker();
}

/** Release the lazy model worker when the host shuts down. */
export async function disposeContextResources(): Promise<void> {
  const ranker = sharedSemanticRanker;
  sharedSemanticRanker = undefined;
  await ranker?.dispose();
}

/** Explicit references written in the instruction: @file:<path> and @symbol:<Name>. */
export function parseMentions(instruction: string): Reference[] {
  const refs: Reference[] = [];
  for (const m of instruction.matchAll(/@file:([^\s,;]+)/g)) refs.push({ kind: 'file', path: m[1]!.replace(/[).]+$/, '') });
  for (const m of instruction.matchAll(/@symbol:([A-Za-z_][\w.]*)/g)) refs.push({ kind: 'symbol', name: m[1]!.replace(/\.+$/, '') });
  return refs;
}

function fence(path: string): string {
  const ext = path.split('.').pop() ?? '';
  return ({ py: 'python', rst: 'rst', md: 'markdown', ts: 'typescript', js: 'javascript', json: 'json', toml: 'toml' } as Record<string, string>)[ext] ?? '';
}

const depth = (c: IndexedChunk): number => (c.qualname ?? '').split('.').length;

/** Top-level definitions and methods (or doc section titles), one line each with its line number. */
function outlineOf(file: IndexedFile): string {
  return file.chunks
    .filter((c) => (c.kind === 'section' ? !!c.name : (c.kind === 'function' || c.kind === 'class') && depth(c) <= 2))
    .slice(0, 40)
    .map((c) => `${String(c.startLine).padStart(5)}  ${c.kind === 'section' ? `§ ${c.name}` : `${'  '.repeat(depth(c) - 1)}${c.signature ?? c.name}`}`)
    .join('\n');
}

function resolveSymbol(index: WorkspaceIndex, name: string): IndexedChunk[] {
  const last = name.split('.').pop()!;
  const hits = index.symbols.get(last) ?? [];
  const exact = hits.filter((c) => c.qualname === name || name === last);
  return exact.length ? exact : hits;
}

export async function assembleContext(port: EditorPort, req: ContextRequest, prebuilt?: WorkspaceIndex, options: ContextAssemblyOptions = {}): Promise<ContextResult> {
  const t0 = Date.now();
  const index = prebuilt ?? await buildIndex(port);
  const budget = Math.max(1, Math.floor(req.budgetTokens));
  let remaining = budget;
  const selections: Selection[] = [];
  const skipped: Skipped[] = index.skipped.map(item => ({ ...item, estimatedTokens: 0 }));
  const parts: string[] = [];
  const pinnedPaths = new Set<string>();
  const includedChunks = new Set<string>();
  const includedRanges = new Map<string, Array<{ startLine: number; endLine: number }>>();

  const markRange = (path: string, startLine: number, endLine: number) => {
    const ranges = includedRanges.get(path) ?? [];
    ranges.push({ startLine, endLine });
    includedRanges.set(path, ranges);
  };
  const overlapsIncludedRange = (path: string, startLine: number, endLine: number) =>
    (includedRanges.get(path) ?? []).some((range) => startLine <= range.endLine && endLine >= range.startLine);

  let used = 0;
  const add = (sel: Omit<Selection, 'rank' | 'estimatedTokens'>, body: string, heading: string): boolean => {
    const tokens = estimateTokens(body) + estimateTokens(heading) + 4;
    if (tokens > remaining) return false;
    remaining -= tokens;
    used += tokens;
    selections.push({ ...sel, rank: selections.length + 1, estimatedTokens: tokens });
    parts.push(`### ${heading}\n\`\`\`${fence(sel.path)}\n${body}\n\`\`\``);
    return true;
  };
  const truncateTo = (text: string, tokens: number): string => {
    const lines = text.split('\n');
    let out = '';
    for (const l of lines) { if (estimateTokens(out + l + '\n') > tokens) break; out += `${l}\n`; }
    return out.trimEnd();
  };

  // 1. Pinned: selection.
  const selectionRefusal = req.selection ? modelPathRefusal(normalizeWorkspacePath(req.selection.path) ?? req.selection.path) : null;
  if (req.selection && selectionRefusal) {
    skipped.push({ path: req.selection.path, reason: `selection not sent: ${selectionRefusal}`, estimatedTokens: 0 });
  } else if (req.selection) {
    const s = req.selection;
    const path = normalizeWorkspacePath(s.path) ?? s.path;
    if (isSecretPath(path)) {
      skipped.push({ path, reason: 'credentials file is not sent to the model', estimatedTokens: 0 });
    } else {
    pinnedPaths.add(path);
    const range = { startLine: s.startLine, endLine: s.endLine };
    const ok = add({ path, range, source: 'selection', rationale: 'selected by the user', truncated: false }, s.text, `${path} lines ${s.startLine}-${s.endLine} (selection)`);
    if (ok) markRange(path, range.startLine, range.endLine);
    if (!ok) {
      const cut = truncateTo(s.text, Math.floor(remaining * 0.8));
      const fitted = cut !== '' && add({ path, range, source: 'selection', rationale: 'selected by the user (truncated to fit the budget)', truncated: true }, cut, `${path} lines ${s.startLine}-${s.endLine} (selection, truncated)`);
      if (fitted) markRange(path, range.startLine, range.endLine);
      if (!fitted) skipped.push({ path, reason: `selection does not fit the context budget (${budget} tokens)`, estimatedTokens: estimateTokens(s.text) });
    }
    }
  }

  // 2. Pinned: explicit @symbol / @file references.
  const refs = [...(req.references ?? []), ...parseMentions(req.instruction)];
  const seenRefs = new Set<string>();
  for (const ref of refs) {
    const key = ref.kind === 'file' ? `f:${ref.path}` : `s:${ref.name}`;
    if (seenRefs.has(key)) continue;
    seenRefs.add(key);
    if (ref.kind === 'symbol') {
      const hits = resolveSymbol(index, ref.name);
      if (!hits.length) { skipped.push({ path: `@symbol:${ref.name}`, reason: 'symbol not found in the workspace index', estimatedTokens: 0 }); continue; }
      for (const c of hits.slice(0, 3)) {
        const label = c.qualname ?? c.name ?? ref.name;
        const ok = add({ path: c.path, symbol: label, range: { startLine: c.startLine, endLine: c.endLine }, source: 'explicit', rationale: `@symbol:${ref.name} requested by the user`, truncated: false }, c.text, `${c.path} lines ${c.startLine}-${c.endLine} · ${label} (@symbol)`);
        if (ok) {
          includedChunks.add(`${c.path}:${c.startLine}`);
          markRange(c.path, c.startLine, c.endLine);
        }
        else skipped.push({ path: c.path, reason: `@symbol:${ref.name} does not fit the remaining budget`, estimatedTokens: estimateTokens(c.text) });
      }
    } else {
      const path = normalizeWorkspacePath(ref.path);
      const refusal = path ? modelPathRefusal(path) : null;
      if (refusal) { skipped.push({ path: ref.path, reason: `@file not sent: ${refusal}`, estimatedTokens: 0 }); continue; }
      const file = path ? index.files.get(path) : undefined;
      const text = path && isSecretPath(path) ? undefined : file?.text ?? (path ? (await port.readText(path).catch(() => null))?.text : undefined);
      if (!path || text === undefined) { skipped.push({ path: ref.path, reason: '@file not found in the workspace', estimatedTokens: 0 }); continue; }
      if (isBinaryText(text)) { skipped.push({ path, reason: '@file not sent: binary (contains NUL bytes)', estimatedTokens: 0 }); continue; }
      pinnedPaths.add(path);
      const lines = text.split('\n').length;
      const cap = Math.floor(remaining * 0.5);
      const truncated = estimateTokens(text) > cap;
      const body = truncated ? truncateTo(text, cap) : text;
      const fitted = body !== '' && add({ path, range: { startLine: 1, endLine: truncated ? body.split('\n').length : lines }, source: 'explicit', rationale: `@file:${ref.path} requested by the user${truncated ? ' (truncated to fit the budget)' : ''}`, truncated }, body, `${path}${truncated ? ' (truncated)' : ''} (@file)`);
      if (!fitted) skipped.push({ path, reason: `@file:${ref.path} does not fit the remaining budget (${remaining} tokens left)`, estimatedTokens: estimateTokens(text) });
    }
  }

  // 3. Pinned: outline of the active file.
  if (req.activeFile) {
    const path = normalizeWorkspacePath(req.activeFile);
    const file = path ? index.files.get(path) : undefined;
    if (file && path) {
      const outline = outlineOf(file);
      if (outline) add({ path, source: 'active', rationale: 'file open in the editor (outline only)', truncated: false }, outline, `${path} outline (active file)`);
    }
  }

  // 4. Automatic retrieval.
  const pinnedSymbols = refs.filter((r): r is Extract<Reference, { kind: 'symbol' }> => r.kind === 'symbol').map((r) => r.name).join(' ');
  const task = `${req.instruction.replace(/@(file|symbol):\S+/g, ' ')} ${pinnedSymbols}`;
  const lexical = rankFiles(index, task);
  let semanticRanks: ReadonlyMap<string, number> | undefined;
  if (req.semanticSearch && !req.signal?.aborted && shouldUseSemantic(lexical.files, lexical.queryTerms)) {
    const candidates = new Map<string, RankedFile>();
    for (const file of lexical.files.slice(0, MAX_SEMANTIC_FILES)) candidates.set(file.path, file);
    const neighbours = lexical.files.filter((file) => file.reasons.some((reason) => /^(tests for|documents|imported by) /.test(reason)));
    for (const file of neighbours.slice(0, MAX_SEMANTIC_FILES)) candidates.set(file.path, file);
    const chunks = [...candidates.values()].flatMap((file) => file.chunks
      .filter((chunk, chunkIndex) => chunk.score > 0 || chunkIndex === 0)
      .slice(0, CHUNKS_PER_FILE)
      .map((rankedChunk) => rankedChunk.chunk));
    if (chunks.length) {
      const ranker = options.semanticRanker ?? defaultSemanticRanker();
      semanticRanks = await ranker.rank(task, chunks, req.signal);
    }
  }
  const { files: ranked } = rankFiles(index, task, semanticRanks);
  const candidates = ranked.filter((f) => f.score > 0);
  const limit = req.mode === 'inline' ? 2 : MAX_RANKED_FILES;
  const chosen = candidates.slice(0, limit);
  const topScore = chosen[0]?.score ?? 1;
  for (const [i, f] of candidates.slice(limit, limit + 6).entries()) {
    skipped.push({ path: f.path, reason: `ranked #${limit + i + 1} (score ${f.score.toFixed(1)} vs top ${topScore.toFixed(1)}), below the cut of ${limit} files`, estimatedTokens: estimateTokens(index.files.get(f.path)?.text ?? '') });
  }
  const why = (f: RankedFile) => f.reasons.join('; ');

  if (req.mode === 'agent') {
    for (const f of chosen.slice(0, OUTLINE_FILES)) {
      if (pinnedPaths.has(f.path)) continue;
      const file = index.files.get(f.path);
      const outline = file ? outlineOf(file) : '';
      if (!outline) continue;
      if (!add({ path: f.path, source: 'automatic', rationale: `outline · ${why(f)}`, truncated: false }, outline, `${f.path} outline (rank ${candidates.indexOf(f) + 1}, score ${f.score.toFixed(1)})`)) {
        skipped.push({ path: f.path, reason: `outline does not fit the remaining budget (${remaining} tokens left)`, estimatedTokens: estimateTokens(outline) });
      }
    }
  }

  const pool = chosen.flatMap((f) => f.chunks
    .filter((r, chunkIndex) => r.score > 0 || r.semanticScore !== undefined || chunkIndex === 0)
    .slice(0, CHUNKS_PER_FILE)
    .map((r) => {
      const tokens = estimateTokens(r.chunk.text);
      const relevance = r.relevance ?? (r.score > 0 ? r.score : f.score * 0.4);
      return { f, r, tokens, relevance, density: relevance / Math.max(tokens, 1) };
    }))
    .sort((a, b) => b.density - a.density || b.relevance - a.relevance || pathOrder(a.r.chunk.path, b.r.chunk.path) || a.r.chunk.startLine - b.r.chunk.startLine);
  for (const { f, r, tokens } of pool) {
    const c = r.chunk;
    const id = `${c.path}:${c.startLine}`;
    if (includedChunks.has(id) || pinnedPaths.has(c.path) || overlapsIncludedRange(c.path, c.startLine, c.endLine)) continue;
    if (tokens > budget * MAX_CHUNK_SHARE) { skipped.push({ path: c.path, reason: `${c.qualname ?? c.name ?? `lines ${c.startLine}-${c.endLine}`} is too large for the budget (${tokens} tokens); the outline lists it`, estimatedTokens: tokens }); continue; }
    const label = c.qualname ?? c.name;
    const matched = r.semanticScore !== undefined
      ? `semantic similarity (${r.semanticScore.toFixed(3)})`
      : r.matched.length ? `matches ${r.matched.slice(0, 4).map((t) => `"${t}"`).join(', ')}` : 'best part of a neighbour file';
    const ok = add(
      { path: c.path, ...(label ? { symbol: label } : {}), range: { startLine: c.startLine, endLine: c.endLine }, source: 'automatic', rationale: `${matched} · ${why(f)}`, truncated: false },
      c.text,
      `${c.path} lines ${c.startLine}-${c.endLine}${label ? ` · ${label}` : ''}`,
    );
    if (ok) {
      includedChunks.add(id);
      markRange(c.path, c.startLine, c.endLine);
    }
    else skipped.push({ path: c.path, reason: `${label ?? `lines ${c.startLine}-${c.endLine}`} skipped: budget exhausted (needs ${tokens}, ${remaining} left)`, estimatedTokens: tokens });
  }

  const visibleSkipped = skipped.slice(0, 20);
  if (skipped.length > 20) visibleSkipped.push({ path: '.', reason: `${skipped.length - 20} additional omissions are not displayed`, estimatedTokens: 0 });
  const report: ContextReport = { budgetTokens: budget, estimatedTokens: used, selections, skipped: visibleSkipped };
  const header = `## Context gathered by the editor (≈${used} of ${budget} tokens; files ranked by relevance to the task)\n` +
    'Line numbers are 1-based. Read more with read_file if you need it; do not assume code you have not seen.';
  return { report, text: [header, ...parts].join('\n\n'), ranked, ms: Date.now() - t0 };
}
