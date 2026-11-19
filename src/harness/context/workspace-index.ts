// In-memory index of the workspace: chunks with term counts, a Python symbol table and import edges.
import type { EditorPort } from '../mcp/port';
import { chunkFile, type Chunk } from './chunks';
import { GitIgnore, isIndexable, MAX_INDEX_CHARS } from './files';
import { countTerms, normalise, splitIdentifier, terms } from './text';

export interface IndexedChunk extends Chunk {
  id: number;
  tf: Map<string, number>;
  length: number;
  /** Normalised parts of the chunk's own name. */
  nameParts: string[];
}

export interface IndexedFile {
  path: string;
  text: string;
  sha256: string;
  chunks: IndexedChunk[];
  /** Dotted Python module name, e.g. flask.cli. */
  module?: string;
  /** Workspace paths this file imports (Python, resolved inside the workspace). */
  imports: string[];
  pathTerms: Set<string>;
}

export interface WorkspaceIndex {
  files: Map<string, IndexedFile>;
  chunks: IndexedChunk[];
  df: Map<string, number>;
  avgLength: number;
  symbols: Map<string, IndexedChunk[]>;
  modules: Map<string, string>;
  skipped: Array<{ path: string; reason: string }>;
}

export function moduleName(path: string): string | undefined {
  if (!path.endsWith('.py')) return undefined;
  let p = path.slice(0, -3);
  if (p.startsWith('src/')) p = p.slice(4);
  if (p.endsWith('/__init__')) p = p.slice(0, -9);
  return p.split('/').join('.');
}

function parseImports(text: string, module: string | undefined, isPackage: boolean): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/^\s*from\s+(\.*)([\w.]*)\s+import\s+([\w*,\s()]+)/gm)) {
    const dots = m[1]!.length;
    let base = m[2]!;
    if (dots && module) {
      const parts = module.split('.');
      const pkg = isPackage ? parts : parts.slice(0, -1);
      base = [...pkg.slice(0, pkg.length - (dots - 1)), ...(base ? [base] : [])].join('.');
    }
    out.push(base);
    for (const name of m[3]!.replace(/[()]/g, '').split(',').map((s) => s.trim().split(/\s+/)[0]!).filter(Boolean)) out.push(`${base}.${name}`);
  }
  for (const m of text.matchAll(/^\s*import\s+([\w.]+)/gm)) out.push(m[1]!);
  return out;
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  }));
  return out;
}

// Matches the editor's maximum inventory size; reaching it is explicitly reported.
export const INDEX_FILE_LIMIT = 2000;

export async function buildIndex(port: EditorPort): Promise<WorkspaceIndex> {
  const all = await port.listFiles({ limit: INDEX_FILE_LIMIT });
  const skipped: Array<{ path: string; reason: string }> = [];
  if (all.length >= INDEX_FILE_LIMIT) skipped.push({ path: '.', reason: `Workspace inventory reached ${INDEX_FILE_LIMIT} files; retrieval coverage may be incomplete. Narrow the workspace to include omitted files.` });
  let ignoreText = '';
  try { ignoreText = (await port.readText('.gitignore'))?.text ?? ''; }
  catch {
    // Do not index files that a missing ignore policy might have excluded.
    return { files: new Map(), chunks: [], df: new Map(), avgLength: 1, symbols: new Map(), modules: new Map(),
      skipped: [...skipped, { path: '.gitignore', reason: 'Cannot read ignore rules; automatic indexing refused until exclusions can be checked.' }] };
  }
  const gitignore = new GitIgnore(ignoreText);
  const candidates = all.filter((p) => isIndexable(p) && !gitignore.ignores(p));
  const files = new Map<string, IndexedFile>();
  const chunks: IndexedChunk[] = [];
  const read = await mapLimit(candidates, 16, async (p) => {
    try { return { p, snap: await port.readText(p), unreadable: false }; }
    catch { return { p, snap: null, unreadable: true }; }
  });
  for (const { p, snap, unreadable } of read) {
    if (unreadable) { skipped.push({ path: p, reason: 'unreadable file; excluded from retrieval' }); continue; }
    if (!snap) { skipped.push({ path: p, reason: 'file disappeared while indexing' }); continue; }
    if (snap.text.length > MAX_INDEX_CHARS) { skipped.push({ path: p, reason: `too large to index (${snap.text.length} chars)` }); continue; }
    if (snap.text.includes('\0')) { skipped.push({ path: p, reason: 'binary' }); continue; }
    const mod = moduleName(p);
    const file: IndexedFile = {
      path: p, text: snap.text, sha256: snap.sha256, chunks: [], imports: [],
      ...(mod ? { module: mod } : {}),
      pathTerms: new Set(p.split('/').flatMap((seg) => splitIdentifier(seg.replace(/\.[^.]+$/, '')).map(normalise))),
    };
    for (const c of chunkFile(p, snap.text)) {
      const tokens = terms(`${c.text}`);
      const ic: IndexedChunk = { ...c, id: chunks.length, tf: countTerms(tokens), length: tokens.length, nameParts: c.name ? splitIdentifier(c.name).map(normalise) : [] };
      chunks.push(ic);
      file.chunks.push(ic);
    }
    files.set(p, file);
  }
  const modules = new Map<string, string>();
  for (const f of files.values()) if (f.module) modules.set(f.module, f.path);
  for (const f of files.values()) {
    if (!f.module) continue;
    const targets = new Set<string>();
    for (const imp of parseImports(f.text, f.module, f.path.endsWith('__init__.py'))) {
      const hit = modules.get(imp) ?? modules.get(imp.split('.').slice(0, -1).join('.'));
      if (hit && hit !== f.path) targets.add(hit);
    }
    f.imports = [...targets];
  }
  const df = new Map<string, number>();
  for (const c of chunks) for (const t of c.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const symbols = new Map<string, IndexedChunk[]>();
  for (const c of chunks) {
    if (!c.name || (c.kind !== 'function' && c.kind !== 'class')) continue;
    const list = symbols.get(c.name) ?? [];
    list.push(c);
    symbols.set(c.name, list);
  }
  const avgLength = chunks.length ? chunks.reduce((s, c) => s + c.length, 0) / chunks.length : 1;
  return { files, chunks, df, avgLength, symbols, modules, skipped };
}
