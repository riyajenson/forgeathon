import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testOutcome } from './test-outcome';

test('pytest -q and -v summaries: counts and the summary line', () => {
  assert.deepEqual(testOutcome('pytest tests/test_cli.py -q', 1, '..F.\nFAILED tests/test_cli.py::test_x - assert 1 == 2\n1 failed, 57 passed, 3 skipped in 0.18s\n'),
    { status: 'failed', command: 'pytest tests/test_cli.py -q', exitCode: 1, passed: 57, failed: 1, summary: '1 failed, 57 passed, 3 skipped in 0.18s' });
  assert.deepEqual(testOutcome('python -m pytest -v', 0, 'tests/a.py::t PASSED\n============ 2 passed in 0.05s ============\n'),
    { status: 'passed', command: 'python -m pytest -v', exitCode: 0, passed: 2, failed: 0, summary: '2 passed in 0.05s' });
  assert.equal(testOutcome('pytest', 1, '=== 1 failed, 2 errors in 1.2s ===').failed, 3, 'errors count as failures');
});

test('no summary (usage error, killed): failed from the exit code, without counts', () => {
  assert.deepEqual(testOutcome('pytest tests/x.py', 4, 'ERROR: file or directory not found: tests/x.py\n\nno tests ran in 0.01s\n'),
    { status: 'failed', command: 'pytest tests/x.py', exitCode: 4, failed: 0, summary: 'no tests ran in 0.01s' });
  assert.deepEqual(testOutcome('pytest', null, ''), { status: 'failed', command: 'pytest', exitCode: null });
});
