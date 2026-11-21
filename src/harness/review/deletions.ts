// Flags hunks that delete a whole Python class or function, so the review can warn before accepting them
// (phase 2: an accepted hunk replaced a test class and all its methods). A definition counts as deleted when its
// header and its entire indented body lie inside the hunk's original range and the replacement text does not
// define the same name again. Nested definitions inside a deleted one are not listed separately.

export interface DeletedDefinition {
  kind: 'class' | 'function';
  name: string;
  /** Lines of the definition in the original text, decorators included, trailing blank lines excluded. */
  lines: number;
}

const HEADER = /^([ \t]*)(?:async[ \t]+def|def|class)[ \t]+([A-Za-z_]\w*)/;
const DECORATOR = /^([ \t]*)@/;

export function deletedDefinitions(original: string, hunk: { startOffset: number; endOffset: number; newText: string }): DeletedDefinition[] {
  const lines = original.split('\n');
  const starts: number[] = [];
  let off = 0;
  for (const l of lines) { starts.push(off); off += l.length + 1; }
  const indentOf = (l: string) => /^[ \t]*/.exec(l)![0].replace(/\t/g, '    ').length;
  const out: DeletedDefinition[] = [];
  let coveredUntil = -1; // line index: inside an already reported definition
  for (let i = 0; i < lines.length; i++) {
    if (i < coveredUntil) continue;
    const m = HEADER.exec(lines[i]!);
    if (!m) continue;
    const indent = indentOf(lines[i]!);
    // Decorators directly above belong to the definition.
    let first = i;
    while (first > 0 && DECORATOR.test(lines[first - 1]!) && indentOf(lines[first - 1]!) === indent) first--;
    // The body: every following line that is blank or indented deeper than the header.
    let end = i + 1;
    while (end < lines.length && (lines[end]!.trim() === '' || indentOf(lines[end]!) > indent)) end++;
    let last = end - 1;
    while (last > i && lines[last]!.trim() === '') last--;
    const blockStart = starts[first]! + (lines[first]!.length - lines[first]!.trimStart().length);
    const blockEnd = starts[last]! + lines[last]!.length;
    if (blockStart < hunk.startOffset || blockEnd > hunk.endOffset) continue;
    const name = m[2]!;
    const kind = /class/.test(lines[i]!.slice(0, lines[i]!.indexOf(name))) ? 'class' : 'function';
    if (new RegExp(`^[ \\t]*(?:async[ \\t]+def|def|class)[ \\t]+${name}\\b`, 'm').test(hunk.newText)) continue;
    out.push({ kind, name, lines: last - first + 1 });
    coveredUntil = end;
  }
  return out;
}
