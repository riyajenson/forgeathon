import type { EditProposal } from 'forge-harness';

type Hunk = EditProposal['hunks'][number];

/** "deletes class TestRoutes (25 lines)" for a hunk that removes whole definitions, else ''. */
export function hunkWarning(h: Hunk): string {
  const d = h.deletes ?? [];
  return d.length ? 'deletes ' + d.map(x => x.kind + ' ' + x.name + ' (' + x.lines + ' lines)').join(', ') : '';
}

/** One line per destructive hunk in a proposal: "Hunk 2 (line 40) deletes class TestRoutes (25 lines)". */
export function proposalWarnings(p: Pick<EditProposal, 'hunks' | 'originalText'>): string[] {
  return p.hunks.flatMap((h, i) => {
    const w = hunkWarning(h);
    return w ? ['Hunk ' + (i + 1) + ' (line ' + p.originalText.slice(0, h.startOffset).split('\n').length + ') ' + w] : [];
  });
}
