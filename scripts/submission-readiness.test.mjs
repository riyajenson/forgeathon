import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSubmission, commitError, isNonRuntime, onlyDescriptionsDiffer } from './check-submission.mjs';

const writeup = ['Team', 'Starting point', 'Architecture on TrueForge', 'How context is selected', 'Model setup', 'Scorecard', 'Tools used', 'Known limitations and what you would do with another month'].map((h, i) => `## ${i + 1}. ${h}\nCompleted evidence`).join('\n\n');
const fixture = () => ({
  repositoryCommit: 'a'.repeat(40), flaskCommit: '22d92470', repositoryUrl: 'https://github.com/example/repo', videoUrl: 'https://example.org/video',
  models: [{ role: 'primary', name: 'provider-a/model', hosting: 'API', approximateCostUsd: 0 }, { role: 'fallback', name: 'provider-b/model', hosting: 'API', approximateCostUsd: 0.02 }],
  tasks: ['A', 'B', 'C'].map(task => ({ task, mode: 'real', model: 'provider-a/model', passed: true, sessionUrl: 'http://localhost:8790/sessions?id=test', verification: 'Observed expected result', recordedAt: '2026-11-19T12:00:00Z', videoTimestamp: '00:30', inputTokens: 100, outputTokens: 50 })),
});
test('current-style placeholders and absent evidence block readiness', () => {
  const errors = checkSubmission(writeup + '\n<Name 1> [mm:ss]', undefined);
  assert.ok(errors.some(e => /placeholders/.test(e)));
  assert.ok(errors.some(e => /evidence is missing/.test(e)));
});
test('complete declared evidence passes field validation', () => assert.deepEqual(checkSubmission(writeup, fixture()), []));
test('mock-only and failed runs cannot satisfy real rehearsal evidence', () => {
  const evidence = fixture(); evidence.tasks[0].mode = 'mock'; evidence.tasks[1].passed = false;
  const errors = checkSubmission(writeup, evidence);
  assert.ok(errors.some(e => /Task A needs/.test(e))); assert.ok(errors.some(e => /Task B needs/.test(e)));
});
test('missing, duplicate or invalid task evidence is rejected', () => {
  const evidence = fixture(); evidence.tasks = [evidence.tasks[0], evidence.tasks[0], { ...evidence.tasks[2], recordedAt: 'bad', inputTokens: -1 }];
  const errors = checkSubmission(writeup, evidence);
  for (const pattern of [/exactly one real-model Task A/, /exactly one real-model Task B/, /Task C needs/, /nonnegative inputTokens/]) assert.ok(errors.some(e => pattern.test(e)));
});
test('model costs and pinned revision must be concrete', () => {
  const evidence = fixture(); evidence.models[0].approximateCostUsd = -1; evidence.models[1].name = 'scripted-demo-model'; evidence.flaskCommit = 'main';
  assert.ok(checkSubmission(writeup, evidence).length >= 3);
});
test('required headings cannot be missing or reordered', () => assert.ok(checkSubmission(writeup.replace('## 1. Team', '## 1. Wrong heading'), fixture()).some(e => /headings/.test(e))));
test('evidence commit: HEAD, or an ancestor followed only by docs commits', () => {
  const rec = 'b'.repeat(40), head = 'c'.repeat(40);
  assert.equal(commitError(rec, rec.toUpperCase(), false, []), undefined);
  assert.equal(commitError(rec, head, true, ['docs/writeup/rehearsal.json', 'README.md']), undefined);
  assert.match(commitError(rec, head, true, ['docs/STATUS.md', 'extension/src/review.ts']), /outside docs and tests: extension\/src\/review\.ts/);
  assert.match(commitError(rec, head, false, []), /rehearse A\/B\/C on the current commit c{40}\.$/);
});

test('evidence survives test, smoke, benchmark and CI commits, but not runtime code', () => {
  const rec = 'a'.repeat(40), head = 'b'.repeat(40);
  for (const f of ['src/harness/turn/turn.test.ts', 'src/harness/integration/turn.itest.ts', 'extension/test/panel.cjs',
    'src/harness/smoke/smoke.ts', 'scripts/bench-context.mjs', 'scripts/check-submission.mjs', '.github/workflows/ci.yml', 'scripts/use-models.test.mjs']) {
    assert.equal(isNonRuntime(f), true, f);
    assert.equal(commitError(rec, head, true, [f]), undefined, f);
  }
  for (const f of ['src/harness/turn/turn.ts', 'extension/media/agent.js', 'agent/forge-coder.json', 'scripts/setup-trueforge.mjs', 'extension/package.json'])
    assert.equal(isNonRuntime(f), false, f);
  assert.match(commitError(rec, head, true, ['src/harness/smoke/smoke.ts', 'src/harness/turn/turn.ts']), /turn\/turn\.ts/);
});

test('a package.json change counts as help text only when nothing but description strings differ', () => {
  const a = JSON.stringify({ contributes: { configuration: { properties: { x: { type: 'boolean', default: false, description: 'old' } } } } });
  const b = JSON.stringify({ contributes: { configuration: { properties: { x: { type: 'boolean', default: false, description: 'new' } } } } });
  const c = JSON.stringify({ contributes: { configuration: { properties: { x: { type: 'boolean', default: true, description: 'new' } } } } });
  assert.equal(onlyDescriptionsDiffer(a, b), true);
  assert.equal(onlyDescriptionsDiffer(a, c), false);
  assert.equal(onlyDescriptionsDiffer(a, '{'), false);
});
