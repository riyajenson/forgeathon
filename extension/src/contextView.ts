import type { ContextReport } from 'forge-harness';

type Item = ContextReport['selections'][number];

/** The context report at a glance: what the user pinned, one row per automatically chosen file, skipped items by reason. */
export interface ContextView { pinned: string[]; files: string[]; skipped: string[] }

const where = (i: Item) => i.symbol ? i.symbol : i.range ? 'lines ' + i.range.startLine + '–' + i.range.endLine : 'outline';

/** Broad skip categories; the full reason stays in the "All entries" list. */
export function skipCategory(reason: string): string {
  if (/below the cut/.test(reason)) return 'Ranked below the file cut';
  if (/budget|does not fit/.test(reason)) return 'Did not fit the token budget';
  if (/credentials|not sent|binary/.test(reason)) return 'Refused by the read policy (never sent)';
  if (/not found/.test(reason)) return 'Not found';
  if (/semantic/.test(reason)) return 'Semantic reranking';
  if (/additional omissions/.test(reason)) return 'More omissions (not listed)';
  return reason;
}

export function contextView(report: ContextReport): ContextView {
  const label = (s: Item['source']) => s === 'selection' ? 'selection' : s === 'explicit' ? 'pinned' : 'active file';
  const pinned = report.selections.filter((i) => i.source !== 'automatic')
    .map((i) => i.path + ' — ' + label(i.source) + ', ' + where(i) + ', ' + i.estimatedTokens + ' tokens' + (i.truncated ? ' (truncated)' : ''));
  const byFile = new Map<string, Item[]>();
  for (const i of [...report.selections].filter((x) => x.source === 'automatic').sort((a, b) => a.rank - b.rank)) {
    const list = byFile.get(i.path) ?? []; list.push(i); byFile.set(i.path, list);
  }
  const files = [...byFile].map(([path, items]) => {
    const tokens = items.reduce((n, i) => n + i.estimatedTokens, 0);
    const parts = [...new Set(items.map(where))];
    const reasons = [...new Set(items.map((i) => i.rationale))];
    return path + ' — ' + parts.join(', ') + ' — ' + tokens + ' tokens — ' + reasons[0] + (reasons.length > 1 ? ' (+' + (reasons.length - 1) + ' more)' : '') +
      (items.some((i) => i.truncated) ? ' (truncated)' : '');
  });
  const groups = new Map<string, { paths: string[]; tokens: number }>();
  for (const s of report.skipped) {
    const g = groups.get(skipCategory(s.reason)) ?? { paths: [], tokens: 0 };
    if (!g.paths.includes(s.path)) g.paths.push(s.path);
    g.tokens += s.estimatedTokens; groups.set(skipCategory(s.reason), g);
  }
  const skipped = [...groups].map(([why, g]) => why + ' — ' + g.paths.length + (g.paths.length === 1 ? ' item: ' : ' items: ') +
    g.paths.slice(0, 6).join(', ') + (g.paths.length > 6 ? ', …' : '') + (g.tokens ? ' (' + g.tokens + ' tokens)' : ''));
  return { pinned, files, skipped };
}
