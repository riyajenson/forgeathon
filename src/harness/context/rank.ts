// Ranks files and chunks for a task: BM25 over identifier-aware terms, symbol and path boosts,
// and neighbour bonuses (tests, docs, imports). Every score comes with plain-English reasons.
import { countTerms, terms } from './text';
import type { IndexedChunk, IndexedFile, WorkspaceIndex } from './workspace-index';

export interface RankedChunk {
  chunk: IndexedChunk;
  score: number;
  matched: string[];
}

export interface RankedFile {
  path: string;
  score: number;
  reasons: string[];
  chunks: RankedChunk[];
}

const K1 = 1.2;
const B = 0.75;
const TOP_SOURCES = 3;
/** Weights for a file's best chunks: many relevant parts beat one lucky match. */
const DECAY = [1, 0.6, 0.4, 0.3, 0.2];
const COVERAGE_WEIGHT = 0.8;
/** Code files are where changes land; docs and tests are reached through neighbour bonuses. */
const CODE_PRIOR = 1.3;
const HISTORY_FILE = /(^|\/)(CHANGES|CHANGELOG|HISTORY|NEWS|RELEASE[_-]?NOTES)[^/]*$/i;

function bm25(index: WorkspaceIndex, chunk: IndexedChunk, query: Map<string, number>): { score: number; matched: Array<[string, number]> } {
  const n = index.chunks.length;
  let score = 0;
  const matched: Array<[string, number]> = [];
  for (const [term, qtf] of query) {
    const tf = chunk.tf.get(term);
    if (!tf) continue;
    const df = index.df.get(term) ?? 0;
    const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
    const s = idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + B * (chunk.length / index.avgLength)))) * Math.min(qtf, 2);
    score += s;
    matched.push([term, s]);
  }
  return { score, matched };
}

const describeChunk = (c: IndexedChunk): string =>
  c.kind === 'function' ? `defines ${c.qualname ?? c.name}()` : c.kind === 'class' ? `defines class ${c.qualname ?? c.name}` : c.name ? `section "${c.name}"` : `lines ${c.startLine}-${c.endLine}`;

export function testFileFor(index: WorkspaceIndex, source: IndexedFile): string | undefined {
  const stem = source.path.split('/').pop()!.replace(/\.py$/, '');
  if (stem === '__init__') return undefined;
  for (const candidate of [`tests/test_${stem}.py`, `test/test_${stem}.py`, `tests/${stem}_test.py`]) if (index.files.has(candidate)) return candidate;
  const dir = source.path.split('/').slice(0, -1).join('/');
  const sibling = `${dir ? `${dir}/` : ''}test_${stem}.py`;
  return index.files.has(sibling) ? sibling : undefined;
}

function docMentions(doc: IndexedFile, source: IndexedFile, symbols: string[]): string[] {
  const hits: string[] = [];
  if (source.module && doc.text.includes(source.module)) hits.push(source.module);
  for (const s of symbols) if (s.length > 3 && doc.text.includes(s) && hits.length < 4) hits.push(s);
  return hits;
}

const SUPPORTING_WEIGHT = 0.6;
const isSupporting = (path: string) => /(^|\/)(tests?|docs?)\//.test(path) || /\.(rst|md)$/.test(path) || /(^|\/)test_[^/]*\.py$/.test(path);
const isCode = (path: string) => !path.startsWith('tests/') && !path.startsWith('docs/') && /\.(py|ts|js|go|rs|java|rb|php|cs|cpp|c)$/.test(path);

export function rankFiles(index: WorkspaceIndex, task: string): { files: RankedFile[]; queryTerms: string[] } {
  const query = countTerms(terms(task));
  const queryTerms = [...query.keys()];
  const byFile = new Map<string, RankedChunk[]>();
  for (const chunk of index.chunks) {
    const { score, matched } = bm25(index, chunk, query);
    if (score <= 0) continue;
    let s = score;
    if (chunk.nameParts.length) s += (chunk.nameParts.filter((p) => query.has(p)).length / chunk.nameParts.length) * 2;
    if (chunk.decorators?.some((d) => queryTerms.some((t) => d.toLowerCase().includes(t)))) s += 1.5;
    const list = byFile.get(chunk.path) ?? [];
    list.push({ chunk, score: s, matched: matched.sort((a, b) => b[1] - a[1]).map(([t]) => t) });
    byFile.set(chunk.path, list);
  }

  const ranked = new Map<string, RankedFile>();
  for (const [path, list] of byFile) {
    list.sort((a, b) => b.score - a.score);
    const file = index.files.get(path)!;
    let score = list.slice(0, DECAY.length).reduce((s, r, i) => s + r.score * DECAY[i]!, 0);
    const covered = new Set(list.flatMap((r) => r.matched));
    score += covered.size * COVERAGE_WEIGHT;
    const reasons: string[] = [];
    const termsHit = [...new Set(list.slice(0, 5).flatMap((r) => r.matched.slice(0, 4)))].slice(0, 6);
    if (termsHit.length) reasons.push(`matches ${termsHit.map((t) => `"${t}"`).join(', ')} (${covered.size} of ${queryTerms.length} task terms)`);
    const named = list.filter((r) => r.chunk.kind === 'function' || r.chunk.kind === 'class').slice(0, 3);
    if (named.length) reasons.push(named.map((r) => describeChunk(r.chunk)).join(', '));
    const pathHits = queryTerms.filter((t) => file.pathTerms.has(t));
    if (pathHits.length) {
      score += Math.min(pathHits.length, 2) * 3;
      reasons.push(`file name matches ${pathHits.map((t) => `"${t}"`).join(', ')}`);
    }
    if (isCode(path)) score *= CODE_PRIOR;
    // Docs and tests restate the task's vocabulary; their own match counts for less, and they rise
    // mainly through the neighbour bonus from the code they document or test.
    else if (isSupporting(path)) score *= SUPPORTING_WEIGHT;
    if (HISTORY_FILE.test(path)) {
      score *= 0.3;
      reasons.push('changelog: down-weighted');
    }
    ranked.set(path, { path, score, reasons, chunks: list });
  }

  // Neighbour bonuses from the strongest code files. Each neighbour takes the best bonus, not the sum.
  const sources = [...ranked.values()].filter((f) => isCode(f.path)).sort((a, b) => b.score - a.score).slice(0, TOP_SOURCES);
  const bonus = new Map<string, { value: number; reason: string }>();
  const offer = (path: string, value: number, reason: string) => {
    const prev = bonus.get(path);
    if (!prev || value > prev.value) bonus.set(path, { value, reason });
  };
  for (const src of sources) {
    const srcFile = index.files.get(src.path)!;
    const test = testFileFor(index, srcFile);
    if (test) offer(test, src.score * 0.4, `tests for ${src.path}`);
    const topSymbols = src.chunks.filter((r) => r.chunk.name && (r.chunk.kind === 'function' || r.chunk.kind === 'class')).slice(0, 5).map((r) => r.chunk.name!);
    for (const doc of index.files.values()) {
      if (!/\.(rst|md)$/.test(doc.path) || HISTORY_FILE.test(doc.path)) continue;
      const hits = docMentions(doc, srcFile, topSymbols);
      if (hits.length >= 2 || (hits.length === 1 && hits[0] === srcFile.module)) offer(doc.path, src.score * (0.2 + 0.1 * Math.min(hits.length, 3)), `documents ${src.path} (mentions ${hits.slice(0, 3).join(', ')})`);
    }
    for (const imp of srcFile.imports) offer(imp, src.score * 0.15, `imported by ${src.path}`);
  }
  for (const [path, b] of bonus) {
    const target = ranked.get(path) ?? { path, score: 0, reasons: [], chunks: [] };
    target.score += b.value;
    target.reasons.push(b.reason);
    ranked.set(path, target);
  }

  for (const f of ranked.values()) {
    if (!f.chunks.length) {
      const file = index.files.get(f.path);
      if (file) f.chunks = file.chunks.map((chunk) => ({ chunk, score: 0, matched: [] }));
    }
  }
  return { files: [...ranked.values()].sort((a, b) => b.score - a.score), queryTerms };
}
