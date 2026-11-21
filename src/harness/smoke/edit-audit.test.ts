import test from 'node:test';
import assert from 'node:assert/strict';
import { addedLines, claimedTests, editFailureKind, TASK_TERMS, testClaimMismatch, unrelatedHunk } from './edit-audit';

const imports = 'import ast\nimport json\nfrom types import ModuleType';

test('added lines ignore unchanged and blank lines', () => {
  assert.deepEqual(addedLines(imports, imports + '\n\n# Test comment'), ['# Test comment']);
  assert.deepEqual(addedLines(imports, 'import ast'), []);
});

test('probe hunks from the phase 1 run are flagged', () => {
  assert.match(unrelatedHunk({ oldText: imports, newText: imports + '\n\n# Test comment' }, 'Test edit', TASK_TERMS['B'])!, /^probe text: /);
  assert.match(unrelatedHunk({ oldText: 'cli = FlaskGroup(', newText: 'def test_func():\n    pass\n\ncli = FlaskGroup(' }, 'Test edit', TASK_TERMS['B'])!, /probe/);
});

test('task B hunks that touch the task pass', () => {
  const b = TASK_TERMS['B'];
  assert.equal(unrelatedHunk({ oldText: 'import inspect', newText: 'import inspect\nimport json' }, 'Add json import', b), undefined);
  assert.equal(unrelatedHunk({ oldText: '', newText: '        self.add_command(config_command)' }, 'Register the command', b), undefined);
  // A related summary covers a hunk whose lines carry no task word (an import the new command needs).
  assert.equal(unrelatedHunk({ oldText: '', newText: 'from flask import current_app' }, 'Imports for the config command', b), undefined);
  assert.equal(unrelatedHunk({ oldText: 'a\nb', newText: 'a' }, 'Remove a line', b), undefined, 'deletions are not judged');
});

test('a hunk with no task term anywhere is flagged; without terms only probes are', () => {
  assert.match(unrelatedHunk({ oldText: '', newText: 'import requests' }, 'Tidy imports', TASK_TERMS['B'])!, /^no task term/);
  assert.equal(unrelatedHunk({ oldText: '', newText: 'import requests' }, 'Tidy imports'), undefined);
});

test('propose_edit failures: malformed versus refused', () => {
  assert.equal(editFailureKind('{"error":"User denied tool call: INVALID_EDIT: edits must be a JSON array"}'), 'malformed');
  assert.equal(editFailureKind('{"error":"User denied tool call: OUTSIDE_WORKSPACE: path must be workspace-relative: undefined"}'), 'malformed');
  assert.equal(editFailureKind('{"error":"STALE_BASE: the file changed"}'), 'refused');
  assert.equal(editFailureKind('{"error":"OLD_TEXT_NOT_FOUND"}'), 'refused');
});

test('test claims in the reply: passed, failed, or none', () => {
  assert.equal(claimedTests('tests/test_cli.py::TestConfig::test_config PASSED'), 'passed');
  assert.equal(claimedTests('All tests pass and the command is documented.'), 'passed');
  assert.equal(claimedTests('57 passed, 3 skipped'), 'passed');
  assert.equal(claimedTests('1 failed, 57 passed'), 'failed');
  assert.equal(claimedTests('The new test still fails because of the fixture.'), 'failed');
  assert.equal(claimedTests('I added the command and documented it.'), undefined);
});

test('a mismatch is recorded only when the claim contradicts the observed outcome', () => {
  assert.equal(testClaimMismatch('All tests pass.', { status: 'failed', summary: '1 failed, 57 passed in 0.18s' }),
    'the reply says the tests pass, but the last test command failed (1 failed, 57 passed in 0.18s)');
  assert.equal(testClaimMismatch('All tests pass.', { status: 'not_run' }), 'the reply says the tests pass, but no test command ran');
  assert.equal(testClaimMismatch('All tests pass.', { status: 'passed' }), undefined);
  assert.equal(testClaimMismatch('Done.', { status: 'failed' }), undefined);
  assert.equal(testClaimMismatch('All tests pass.', undefined), undefined);
});
