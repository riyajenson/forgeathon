import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { approvalKey, commandTestHooks, FakePort, isAutoApprovableCommand, isListedCommand, runCommandTool, ScopeRegistry, type CommandRun, type SessionScope, type ToolContext } from './index';

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
  assert.match(r.text, /Files changed by the command \(outside review\): made\.txt, tracked\.txt/);
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
  assert.ok(r.ok && /changed by the command \(outside review\): tracked\.txt/.test(r.text));
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

test('Stop right after approval: the command never starts (cancel during the first await)', async () => {
  const args = { command: 'printf EXECUTED_AFTER_CANCEL > ran.txt' };
  approve(args);
  const p = runCommandTool(ctx, args);
  scope.cancel(); // synchronously after the call: the tool is parked at its first await
  const r = await p;
  assert.equal(!r.ok && r.code, 'CANCELLED');
  await assert.rejects(fs.access(path.join(root, 'ran.txt')), 'the command did not run');
  assert.equal(scope.writes, 0);
  assert.equal(runs.length, 0);
});

test('Stop after preparation, immediately before spawn: the command never starts', async () => {
  const args = { command: 'printf EXECUTED_AFTER_CANCEL > ran.txt' };
  approve(args);
  commandTestHooks.beforeSpawn = () => scope.cancel();
  try {
    const r = await runCommandTool(ctx, args);
    assert.equal(!r.ok && r.code, 'CANCELLED');
  } finally {
    commandTestHooks.beforeSpawn = undefined;
  }
  await assert.rejects(fs.access(path.join(root, 'ran.txt')), 'the command did not run');
  assert.equal(scope.writes, 0);
  assert.equal(scope.running.size, 0);
});

test('cancel kills the whole process group, including background children', async () => {
  const args = { command: '(sleep 1; echo late > late.txt) & sleep 30' };
  approve(args);
  const p = runCommandTool(ctx, args);
  setTimeout(() => scope.cancel(), 300);
  const r = await p;
  assert.ok(r.ok && /killed: turn cancelled/.test(r.text));
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await assert.rejects(fs.access(path.join(root, 'late.txt')), 'the background child was killed too');
});

test('credential-like environment variables are withheld from the command', async () => {
  process.env['FORGE_TEST_API_KEY'] = 'sk-test-not-a-real-key';
  process.env['FORGE_TEST_TOKEN'] = 'tok';
  try {
    const args = { command: 'env' };
    approve(args);
    const r = await runCommandTool(ctx, args);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.doesNotMatch(r.text, /FORGE_TEST_API_KEY|sk-test-not-a-real-key|FORGE_TEST_TOKEN/);
    assert.match(r.text, /\nPATH=/, 'ordinary variables are kept');
    assert.match(r.text, /credential-like variable\(s\) withheld/);
  } finally {
    delete process.env['FORGE_TEST_API_KEY'];
    delete process.env['FORGE_TEST_TOKEN'];
  }
});

test('a cwd that resolves outside the workspace through a symlink is refused', async () => {
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-outside-'));
  await fs.symlink(outside, path.join(root, 'escape'));
  try {
    const args = { command: 'touch pwned', cwd: 'escape' };
    approve(args);
    const r = await runCommandTool(ctx, args);
    assert.equal(!r.ok && r.code, 'OUTSIDE_WORKSPACE');
    await assert.rejects(fs.access(path.join(outside, 'pwned')));
  } finally {
    await fs.rm(path.join(root, 'escape'), { force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test('verification commands are listed; anything else is unrestricted', () => {
  for (const c of [
    'pytest tests/test_cli.py -q',
    'python -m pytest tests/test_cli.py -q',
    '.venv/bin/python -m pytest -q',
    'python3 -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"',
    'FLASK_DEBUG=off python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"',
    'flask --app flaskr --help',
    'git status --short',
    'git diff --stat',
  ]) assert.equal(isListedCommand(c), true, c);
  for (const c of [
    'rm -rf src',
    'pytest; rm -rf src',
    'pytest && curl http://example.com',
    'git diff --output=src/x.py',
    'python -c "$(cat payload)"',
    'python script.py',
    'git checkout -- .',
    'echo x > src/flask/cli.py',
    'pytest `rm -rf .`',
    'cd examples && flask --help',
  ]) assert.equal(isListedCommand(c), false, c);
});

test('auto-approvable: only bare pytest, python -m pytest, git status and git diff without shell operators', () => {
  for (const c of ['pytest', 'pytest tests/test_cli.py -q', 'python -m pytest -q', 'python3 -m pytest tests', 'python3.12 -m pytest', 'git status --short', 'git diff --stat', '  git diff  ']) {
    assert.equal(isAutoApprovableCommand(c), true, c);
  }
  for (const c of [
    'python -c "print(1)"', 'flask routes', 'flask --app flaskr --help', // listed, but always prompt
    '.venv/bin/pytest -q', './pytest', 'tools/python -m pytest', // a path could name any workspace script
    'PYTHONPATH=src pytest', 'PYTEST_ADDOPTS=-p evil pytest', // environment prefixes change what runs
    'pytest | tail -5', 'pytest && rm -rf x', 'git diff --output=src/x.py', 'git diff --ext-diff', 'git log', 'pytestx',
  ]) assert.equal(isAutoApprovableCommand(c), false, c);
});

test('cancel kills a running command', async () => {
  const slow = { command: 'sleep 30' };
  approve(slow);
  const p = runCommandTool(ctx, slow);
  setTimeout(() => scope.cancel(), 300);
  const r = await p;
  assert.ok(r.ok && /killed: turn cancelled/.test(r.text));
});

test('a workspace virtualenv comes first on PATH', async () => {
  const bin = path.join(root, '.venv', 'bin');
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(bin, 'python'), '#!/bin/sh\necho venv-python\n', { mode: 0o755 });
  try {
    const args = { command: 'python' };
    approve(args);
    const r = await runCommandTool(ctx, args);
    assert.ok(r.ok && /--- stdout ---\nvenv-python/.test(r.text), r.ok ? r.text : r.message);
  } finally {
    await fs.rm(path.join(root, '.venv'), { recursive: true, force: true });
  }
});

test('warns when the turn left unsaved editor changes', async () => {
  scope.unsavedPaths.add('src/app.py');
  const args = { command: 'true' };
  approve(args);
  const r = await runCommandTool(ctx, args);
  assert.ok(r.ok && /unsaved editor changes are not visible to this command: src\/app\.py/.test(r.text));
});
