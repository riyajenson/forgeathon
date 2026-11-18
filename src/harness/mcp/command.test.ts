import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { approvalKey, FakePort, runCommandTool, ScopeRegistry, type CommandRun, type SessionScope, type ToolContext } from './index';

let root: string;
let scope: SessionScope;
let ctx: ToolContext;
let runs: CommandRun[];
const callRef = { sessionId: 's', turnId: 't', callId: 'c' };

function approve(args: { command: string; cwd?: string; timeout_sec?: number }): void {
  scope.commands.record(approvalKey('run_command', args), { callRef, command: args.command, cwd: args.cwd ?? '.' });
}

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-cmd-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: root });
  await fs.writeFile(path.join(root, 'tracked.txt'), 'one\n');
  execFileSync('git', ['add', 'tracked.txt'], { cwd: root });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'tracked'], { cwd: root });
});

after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  scope = new ScopeRegistry().open('tf-1');
  scope.workspaceRoot = root;
  runs = [];
  scope.onCommand = (r) => { runs.push(r); };
  ctx = { port: new FakePort(root), scope };
  execFileSync('git', ['checkout', '-q', '--', '.'], { cwd: root });
  execFileSync('git', ['clean', '-qfd'], { cwd: root });
});

test('refuses without an approval, unbound, or after cancel', async () => {
  const r = await runCommandTool(ctx, { command: 'echo hi' });
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.code, 'NO_REVIEW_DECISION');
  assert.equal((await runCommandTool({ port: ctx.port, scope: undefined }, { command: 'echo hi' })).ok, false);
  approve({ command: 'echo hi' });
  scope.cancel();
  const c = await runCommandTool(ctx, { command: 'echo hi' });
  assert.equal(!c.ok && c.code, 'CANCELLED');
  assert.equal(runs.length, 0);
});

test('runs an approved command once, reports output, exit code and changed files', async () => {
  const args = { command: 'echo out; echo err >&2; echo two >> tracked.txt; echo new > made.txt; exit 3' };
  approve(args);
  const r = await runCommandTool(ctx, args);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.match(r.text, /exit code: 3/);
  assert.match(r.text, /--- stdout ---\nout/);
  assert.match(r.text, /--- stderr ---\nerr/);
  assert.match(r.text, /Files changed by the command: made\.txt, tracked\.txt/);
  assert.deepEqual(runs[0]!.changedFiles, ['made.txt', 'tracked.txt']);
  assert.equal(scope.writes, 1, 'a command counts as a write');
  const again = await runCommandTool(ctx, args);
  assert.equal(!again.ok && again.code, 'NO_REVIEW_DECISION', 'approval is used once');
});

test('detects a further change to an already modified file, and reports none when nothing changed', async () => {
  await fs.appendFile(path.join(root, 'tracked.txt'), 'dirty\n');
  const touch = { command: 'echo more >> tracked.txt' };
  approve(touch);
  const r = await runCommandTool(ctx, touch);
  assert.ok(r.ok && /changed by the command: tracked\.txt/.test(r.text));
  const noop = { command: 'true' };
  approve(noop);
  const n = await runCommandTool(ctx, noop);
  assert.ok(n.ok && /changed by the command: none/.test(n.text));
});

test('cwd must stay inside the workspace; timeout kills the process group', async () => {
  const bad = { command: 'pwd', cwd: '../' };
  approve(bad);
  const b = await runCommandTool(ctx, bad);
  assert.equal(!b.ok && b.code, 'OUTSIDE_WORKSPACE');
  const slow = { command: 'sleep 30 & sleep 30; echo never', timeout_sec: 1 };
  approve(slow);
  const t0 = Date.now();
  const s = await runCommandTool(ctx, slow);
  assert.ok(Date.now() - t0 < 6000, 'killed promptly');
  assert.ok(s.ok && /killed: exceeded 1 s/.test(s.text));
  assert.ok(s.ok && /--- stdout ---\n\n--- stderr ---/.test(s.text), 'the command after the killed sleep never ran');
});

test('cancel kills a running command', async () => {
  const slow = { command: 'sleep 30' };
  approve(slow);
  const p = runCommandTool(ctx, slow);
  setTimeout(() => scope.cancel(), 300);
  const r = await p;
  assert.ok(r.ok && /killed: turn cancelled/.test(r.text));
});

test('warns when the turn left unsaved editor changes', async () => {
  scope.unsavedPaths.add('src/app.py');
  const args = { command: 'true' };
  approve(args);
  const r = await runCommandTool(ctx, args);
  assert.ok(r.ok && /unsaved editor changes are not visible to this command: src\/app\.py/.test(r.text));
});
