// Pure search/replace proposal logic. No I/O, no contract imports.

/**
 * Some models (seen with NVIDIA Nemotron-3 Ultra, 2026-11-19) send the edits array JSON-encoded as a string.
 * A string that parses to an array is used as that array; anything else is returned unchanged. Applied
 * wherever propose_edit arguments are read (review, approval key, MCP execution, summaries) so they agree.
 */
export function normalizeEdits(edits: unknown): unknown {
  if (typeof edits !== 'string' || !edits.trim().startsWith('[')) return edits;
  try {
    const parsed: unknown = JSON.parse(edits);
    return Array.isArray(parsed) ? parsed : edits;
  } catch {
    return edits;
  }
}

export interface SearchReplaceEdit {
  old_text: string;
  new_text: string;
}

/** One reviewable change. Offsets index into the text the proposal was computed from. */
export interface ProposalHunk {
  /** Position in file order (0-based); stable hunk id is `${proposalId}#${index}`. */
  index: number;
  /** 1-based inclusive line range of oldText in the original text (endLine = startLine - 1 for a pure insertion). */
  startLine: number;
  endLine: number;
  oldText: string;
  newText: string;
  start: number;
  end: number;
}

export type ProposalErrorCode = 'OLD_TEXT_NOT_FOUND' | 'OLD_TEXT_AMBIGUOUS' | 'OVERLAPPING_EDITS' | 'INVALID_EDIT';

export interface ProposalError {
  ok: false;
  code: ProposalErrorCode;
  message: string;
  /** Index into the edits array as given by the model. */
  editIndex?: number;
}

export interface Proposal {
  ok: true;
  isNewFile: boolean;
  eol: '\n' | '\r\n';
  hunks: ProposalHunk[];
  proposedText: string;
}

export type ApplyErrorCode = 'STALE_BASE' | 'UNKNOWN_HUNK';

export class ApplyError extends Error {
  constructor(readonly code: ApplyErrorCode, message: string) {
    super(message);
    this.name = 'ApplyError';
  }
}

/** Detects the dominant line ending; LF when the text has no CRLF. */
export function detectEol(text: string): '\n' | '\r\n' {
  const crlf = text.split('\r\n').length - 1;
  if (crlf === 0) return '\n';
  const lf = text.split('\n').length - 1 - crlf;
  return crlf >= lf ? '\r\n' : '\n';
}

/** Rewrites every line ending in `s` to `eol`. */
function toEol(s: string, eol: '\n' | '\r\n'): string {
  const lf = s.replace(/\r\n/g, '\n');
  return eol === '\n' ? lf : lf.replace(/\n/g, '\r\n');
}

function countOccurrences(haystack: string, needle: string): { count: number; first: number } {
  let count = 0;
  let first = -1;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) break;
    if (count === 0) first = at;
    count++;
    from = at + 1;
  }
  return { count, first };
}

function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

function newlineCount(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}

/**
 * Turns model-supplied search/replace edits into non-overlapping hunks in file order.
 *
 * - `currentText === null` means the file does not exist: exactly one edit with empty old_text creates it.
 * - Each old_text must match the current text exactly once. Line endings in the edit are normalised
 *   to the file's dominant line ending before matching, so LF edits apply to CRLF files.
 */
export function computeProposal(currentText: string | null, rawEdits: readonly SearchReplaceEdit[]): Proposal | ProposalError {
  const edits = normalizeEdits(rawEdits) as readonly SearchReplaceEdit[];
  if (typeof edits === 'string') {
    return { ok: false, code: 'INVALID_EDIT', message: 'edits must be a JSON array of {"old_text": ..., "new_text": ...} objects; it was a string that is not valid JSON for one. Pass the array itself, not a string' };
  }
  if (!Array.isArray(edits) || edits.length === 0) {
    return { ok: false, code: 'INVALID_EDIT', message: 'edits must be a non-empty array of {"old_text": ..., "new_text": ...} objects' };
  }

  if (currentText === null) {
    const only = edits[0];
    if (edits.length !== 1 || !only || only.old_text !== '') {
      return { ok: false, code: 'INVALID_EDIT', message: 'a new file takes exactly one edit with empty old_text' };
    }
    const eol = detectEol(only.new_text);
    return {
      ok: true,
      isNewFile: true,
      eol,
      hunks: [{ index: 0, startLine: 1, endLine: 0, oldText: '', newText: only.new_text, start: 0, end: 0 }],
      proposedText: only.new_text,
    };
  }

  const eol = detectEol(currentText);
  const located: Omit<ProposalHunk, 'index'>[] = [];
  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];
    if (!edit || typeof edit.old_text !== 'string' || typeof edit.new_text !== 'string') {
      return { ok: false, code: 'INVALID_EDIT', message: `edit ${i} must have string old_text and new_text`, editIndex: i };
    }
    if (edit.old_text === '') {
      return { ok: false, code: 'INVALID_EDIT', message: `edit ${i}: old_text is empty but the file already exists`, editIndex: i };
    }
    const oldText = toEol(edit.old_text, eol);
    const newText = toEol(edit.new_text, eol);
    if (oldText === newText) {
      return { ok: false, code: 'INVALID_EDIT', message: `edit ${i}: old_text and new_text are identical`, editIndex: i };
    }
    const { count, first } = countOccurrences(currentText, oldText);
    if (count === 0) {
      return { ok: false, code: 'OLD_TEXT_NOT_FOUND', message: `edit ${i}: old_text was not found in the file`, editIndex: i };
    }
    if (count > 1) {
      return { ok: false, code: 'OLD_TEXT_AMBIGUOUS', message: `edit ${i}: old_text matches ${count} places; include more surrounding lines`, editIndex: i };
    }
    const startLine = lineOf(currentText, first);
    const span = oldText.endsWith('\n') ? oldText.slice(0, -1) : oldText;
    located.push({ startLine, endLine: startLine + newlineCount(span), oldText, newText, start: first, end: first + oldText.length });
  }

  const order = located.map((h, i) => ({ h, i })).sort((a, b) => a.h.start - b.h.start);
  for (let k = 1; k < order.length; k++) {
    const prev = order[k - 1]!;
    const cur = order[k]!;
    if (cur.h.start < prev.h.end) {
      return { ok: false, code: 'OVERLAPPING_EDITS', message: `edits ${prev.i} and ${cur.i} overlap`, editIndex: cur.i };
    }
  }

  const hunks: ProposalHunk[] = order.map(({ h }, index) => ({ index, ...h }));
  return { ok: true, isNewFile: false, eol, hunks, proposedText: applyAccepted(currentText, hunks, hunks.map((h) => h.index)).text };
}

export interface ApplyOutcome {
  text: string;
  applied: number[];
  rejected: number[];
}

/**
 * Applies only the accepted hunks to `baseText` (the text the hunks were computed from).
 * Throws ApplyError('STALE_BASE') if any hunk no longer lines up with `baseText`.
 */
export function applyAccepted(baseText: string, hunks: readonly ProposalHunk[], accepted: Iterable<number>): ApplyOutcome {
  const acceptedSet = new Set(accepted);
  for (const idx of acceptedSet) {
    if (!hunks.some((h) => h.index === idx)) throw new ApplyError('UNKNOWN_HUNK', `hunk ${idx} does not exist`);
  }
  for (const h of hunks) {
    if (baseText.slice(h.start, h.end) !== h.oldText) {
      throw new ApplyError('STALE_BASE', `hunk ${h.index} no longer matches the file`);
    }
  }
  const sorted = [...hunks].sort((a, b) => a.start - b.start);
  let out = '';
  let cursor = 0;
  const applied: number[] = [];
  const rejected: number[] = [];
  for (const h of sorted) {
    out += baseText.slice(cursor, h.start);
    if (acceptedSet.has(h.index)) {
      out += h.newText;
      applied.push(h.index);
    } else {
      out += h.oldText;
      rejected.push(h.index);
    }
    cursor = h.end;
  }
  out += baseText.slice(cursor);
  return { text: out, applied, rejected };
}

/** Lines of current text a no-match hint shows at most. */
export const NO_MATCH_HINT_LINES = 12;

/**
 * For an old_text that matches nowhere: where the closest text is, and what it says now, so the model can retry
 * without another read. Matching is whitespace-insensitive first, then on the first non-blank line. '' when no
 * candidate is found (the model should read the file again).
 */
export function noMatchHint(currentText: string, oldText: string): string {
  const lines = currentText.split(/\r?\n/);
  const want = oldText.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '');
  if (!want.length) return '';
  const norm = (l: string) => l.trim();
  const show = (a: number, b: number) => {
    const end = Math.min(b, a + NO_MATCH_HINT_LINES - 1);
    const body = lines.slice(a - 1, end).map((l, i) => `${a + i}\t${l}`).join('\n');
    return `${body}${end < b ? `\n[... ${b - end} more lines]` : ''}`;
  };
  // 1. The same non-blank lines exist with different indentation or spacing.
  const spans: Array<[number, number]> = [];
  for (let i = 0; i < lines.length && spans.length < 2; i++) {
    if (norm(lines[i]!) !== want[0]) continue;
    let j = i, k = 0;
    while (j < lines.length && k < want.length) {
      if (norm(lines[j]!) === '') { j++; continue; }
      if (norm(lines[j]!) !== want[k]) break;
      j++; k++;
    }
    if (k === want.length) spans.push([i + 1, j]);
  }
  if (spans.length === 1) {
    const [a, b] = spans[0]!;
    return `Closest match: lines ${a}-${b} match old_text if whitespace is ignored; copy old_text exactly from the current text:\n${show(a, b)}`;
  }
  // 2. The first line of old_text is in the file once: show what follows it now.
  const firstAt = lines.flatMap((l, i) => (norm(l) === want[0] ? [i + 1] : []));
  if (firstAt.length === 1) {
    const a = firstAt[0]!;
    return `Closest match: old_text's first line is line ${a}, but the lines after it differ now. Current text:\n${show(a, Math.min(lines.length, a + want.length + 1))}`;
  }
  if (firstAt.length > 1) return `old_text's first line occurs at lines ${firstAt.slice(0, 5).join(', ')}${firstAt.length > 5 ? ', …' : ''}, but no complete match; read those lines again.`;
  return '';
}
