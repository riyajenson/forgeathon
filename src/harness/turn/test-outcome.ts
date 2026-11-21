// The observed outcome of a test command (pytest, python -m pytest), from its exit code and output: what the panel
// shows next to the model's summary, independent of what the model says about it.

export interface TestOutcome {
  status: 'passed' | 'failed';
  command: string;
  exitCode: number | null;
  passed?: number;
  failed?: number;
  /** pytest's final summary line ("1 failed, 57 passed, 3 skipped in 0.18s"), if found. */
  summary?: string;
}

const COUNT = /(\d+) (passed|failed|errors?|skipped|xfailed|xpassed|deselected|warnings?)\b/g;

export function testOutcome(command: string, exitCode: number | null, output: string): TestOutcome {
  const lines = output.split('\n').map((l) => l.replace(/^=+\s*|\s*=+$/g, '').trim()).filter(Boolean);
  const summary = [...lines].reverse().find((l) => /\b\d+ (passed|failed|errors?)\b.* in [\d.]+s\b|\bno tests ran\b/.test(l));
  const counts: Record<string, number> = {};
  for (const m of (summary ?? '').matchAll(COUNT)) counts[m[2]!.replace(/s$/, '')] = Number(m[1]);
  const failed = (counts['failed'] ?? 0) + (counts['error'] ?? 0);
  return {
    status: exitCode === 0 ? 'passed' : 'failed',
    command, exitCode,
    ...(counts['passed'] !== undefined ? { passed: counts['passed'] } : {}),
    ...(summary ? { failed } : {}),
    ...(summary ? { summary: summary.slice(0, 200) } : {}),
  };
}
