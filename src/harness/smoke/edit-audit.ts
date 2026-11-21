// Run-record checks for the real-model smoke: accepted hunks that look unrelated to the task, and propose_edit
// failures split into malformed calls and refused edits. Reporting only; the smoke's decisions do not change.

/** Words an accepted hunk for each fixed task is expected to touch (in its added lines or its proposal summary). */
export const TASK_TERMS: Record<string, RegExp> = {
  A: /debug|flag|false|\boff\b|\bno\b|['"]n['"]|lower/i,
  B: /config|json|mask|secret|password|token|\bkey|\*\*\*/i,
};

/** Text a model writes when it probes the edit tool instead of making the change. */
const PROBE = /\btest (comment|edit)\b|\bprobe\b|\bdummy\b|\bplaceholder\b|lorem ipsum|\bdef test_func\b/i;

/** Lines of newText that are not in oldText and are not blank. */
export function addedLines(oldText: string, newText: string): string[] {
  const before = new Set(oldText.split('\n').map((l) => l.trim()));
  return newText.split('\n').filter((l) => l.trim() !== '' && !before.has(l.trim()));
}

/**
 * Why an accepted hunk looks unrelated to the task, or undefined when it looks related. A hunk that only removes
 * or re-indents lines is not judged. Without terms for the task, only probe text is reported.
 */
export function unrelatedHunk(hunk: { oldText: string; newText: string }, summary: string, terms?: RegExp): string | undefined {
  const added = addedLines(hunk.oldText, hunk.newText);
  if (added.length === 0) return undefined;
  const probe = [summary, ...added].find((l) => PROBE.test(l));
  if (probe !== undefined) return `probe text: ${probe.trim().slice(0, 80)}`;
  if (terms && !terms.test(summary) && !added.some((l) => terms.test(l))) return `no task term in the added lines: ${added[0]!.trim().slice(0, 80)}`;
  return undefined;
}

/** Malformed calls (bad arguments: the edit never reached a review) versus refused edits (well-formed but rejected). */
export function editFailureKind(summary: string): 'malformed' | 'refused' {
  return /INVALID_EDIT|INVALID_ARGS|OUTSIDE_WORKSPACE/.test(summary) ? 'malformed' : 'refused';
}
