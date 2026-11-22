import type { HarnessEvent } from 'forge-harness';

type Tests = Extract<HarnessEvent, {t: 'done'}>['tests'];

/** What the model's reply says about the tests, if anything (mirrors the smoke runner's check in src/harness/smoke/edit-audit.ts). */
export function claimedTests(reply: string): 'passed' | 'failed' | undefined {
  const t = reply.slice(-4000);
  if (/\b[1-9]\d* (failed|errors?)\b|\btests? (still |are )?fail(s|ed|ing)?\b|\bfailing tests?\b/i.test(t)) return 'failed';
  if (/\b\d+ passed\b|\bPASSED\b|\b(all|the|new) (\w+ )?tests? (now )?pass(es|ed)?\b|\btests? (are )?(passing|pass)\b/i.test(t)) return 'passed';
  return undefined;
}

/**
 * The turn-end verification verdict for an agent turn that finished normally and changed files: "Verified" only when the
 * last observed test command passed and nothing changed after it. Otherwise "Unverified" with the reason, so a turn that
 * ends with failing, stale or missing tests is never shown as a plain success. Also flags a reply that claims otherwise.
 * Empty for inline turns, unfinished turns and turns that changed nothing.
 */
export function verificationLine(status: string, tests: Tests, changedFiles: number, reply: string): string {
  if (status !== 'done' || !tests || changedFiles === 0) return '';
  const why = tests.status === 'not_run' ? 'code changed, but no test ran in this turn'
    : tests.editedAfter?.length ? tests.editedAfter.join(', ') + ' changed after the last test run'
    : tests.status === 'failed' ? 'the last test run failed' + (tests.summary ? ' (' + tests.summary + ')' : '')
    : '';
  const claim = claimedTests(reply);
  if (!why) return '✓ Verified: the last test run passed after the last edit' + (claim === 'failed' ? ' (the reply says the tests fail)' : '');
  const contradiction = claim === 'passed' ? ' The reply says the tests pass; the observed result does not back that.' : '';
  return '⚠ Unverified: ' + why + '.' + contradiction + ' Review the changes and run the tests before relying on them.';
}
