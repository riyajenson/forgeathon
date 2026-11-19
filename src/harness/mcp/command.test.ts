import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { approvalKey, FakePort, runCommandTool, ScopeRegistry, type CommandRun, type SessionScope, type ToolContext } from './index';
import { checkProtection, confinedCwd, protectedArgs } from './command-protection';
import type { CommandRuntime } from './command';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

let root: string;
let scope: SessionScope;
let ctx: ToolContext;
let runs: CommandRun[];
let protectionAvailable = false;
function protectedTest(name: string, fn: () => Promise<void>) {
  test(name, async (t) => {
    if (!protectionAvailable) return t.skip('Linux bubblewrap/user namespaces unavailable');
    await fn();
  });
}
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
  try { await checkProtection(root, new AbortController().signal); protectionAvailable = true; } catch { /* explicitly skipped below */ }
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

protectedTest('runs an approved command once, reports output and exit code without writes', async () => {
  const args = { command: 'echo out; echo err >&2; exit 3' };
  approve(args);
  const r = await runCommandTool(ctx, args);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.match(r.text, /exit code: 3/);
  assert.match(r.text, /--- stdout ---\nout/);
  assert.match(r.text, /--- stderr ---\nerr/);
  assert.match(r.text, /Files changed by the command: none/);
  assert.deepEqual(runs[0]!.changedFiles, []);
  assert.equal(scope.writes, 1, 'a command counts as a write');
  const again = await runCommandTool(ctx, args);
  assert.equal(!again.ok && again.code, 'NO_REVIEW_DECISION', 'approval is used once');
});

protectedTest('refuses writes to tracked and new files while permitting temporary files', async () => {
  await fs.appendFile(path.join(root, 'tracked.txt'), 'dirty\n');
  const touch = { command: 'echo more >> tracked.txt' };
  approve(touch);
  const r = await runCommandTool(ctx, touch);
  assert.ok(r.ok && /Read-only file system/.test(r.text));
  assert.equal(await fs.readFile(path.join(root, 'tracked.txt'), 'utf8'), 'one\ndirty\n');
  const noop = { command: 'echo no > made.txt; echo yes > /tmp/scratch; cat /tmp/scratch' };
  approve(noop);
  const n = await runCommandTool(ctx, noop);
  assert.ok(n.ok && /changed by the command: none/.test(n.text));
  assert.ok(n.ok && /yes/.test(n.text));
  await assert.rejects(fs.access(path.join(root, 'made.txt')));
});

protectedTest('cwd must stay inside the workspace; timeout kills the process group', async () => {
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

protectedTest('cancel kills a running command', async () => {
  const slow = { command: 'sleep 30' };
  approve(slow);
  const p = runCommandTool(ctx, slow);
  setTimeout(() => scope.cancel(), 300);
  const r = await p;
  assert.ok(r.ok && /killed: turn cancelled/.test(r.text));
});

protectedTest('a workspace virtualenv comes first on PATH', async () => {
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

protectedTest('warns when the turn left unsaved editor changes', async () => {
  scope.unsavedPaths.add('src/app.py');
  const args = { command: 'true' };
  approve(args);
  const r = await runCommandTool(ctx, args);
  assert.ok(r.ok && /unsaved editor changes are not visible to this command: src\/app\.py/.test(r.text));
});

function noSpawnRuntime(): CommandRuntime {
  return {
    snapshot: async () => new Map(), environment: async () => ({}), checkProtection: async () => {},
    spawn: (() => { assert.fail('a cancelled or unprotected command must not spawn'); }) as CommandRuntime['spawn'],
  };
}

for (const step of ['snapshot', 'environment', 'checkProtection'] as const) {
  test(`cancellation during ${step} prevents spawn and releases controller`, async () => {
    const runtime = noSpawnRuntime();
    if (step === 'snapshot') runtime.snapshot = async () => { scope.cancel(); return new Map(); };
    if (step === 'environment') runtime.environment = async () => { scope.cancel(); return {}; };
    if (step === 'checkProtection') runtime.checkProtection = async () => { scope.cancel(); };
    const args = { command: 'echo should-not-run' }; approve(args);
    const r = await runCommandTool(ctx, args, runtime);
    assert.ok(!r.ok && r.code === 'CANCELLED');
    assert.equal(scope.writes, 0); assert.equal(scope.running.size, 0);
  });
}

test('unavailable protection fails closed and releases the controller', async () => {
  const runtime = noSpawnRuntime(); runtime.checkProtection = async () => { throw new Error('bubblewrap unavailable'); };
  const args = { command: 'echo hi' }; approve(args);
  const r = await runCommandTool(ctx, args, runtime);
  assert.ok(!r.ok && /bubblewrap unavailable/.test(r.message));
  assert.equal(scope.writes, 0); assert.equal(scope.running.size, 0);
});

test('abort during spawn is observed even before the abort listener is attached', async (t) => {
  const kill = t.mock.method(process, 'kill', () => true);
  const runtime = noSpawnRuntime();
  runtime.spawn = (() => {
    const child = Object.assign(new EventEmitter(), { pid: 12345, stdout: new PassThrough(), stderr: new PassThrough() });
    scope.cancel();
    setImmediate(() => child.emit('close', null));
    return child;
  }) as unknown as CommandRuntime['spawn'];
  const args = { command: 'echo hi' }; approve(args);
  const r = await runCommandTool(ctx, args, runtime);
  assert.ok(r.ok && /killed: turn cancelled/.test(r.text));
  assert.deepEqual(kill.mock.calls[0]?.arguments, [-12345, 'SIGTERM']);
  assert.equal(scope.running.size, 0);
});

test('working directory refuses symlink escape', async () => {
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-outside-'));
  try {
    await fs.symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(confinedCwd(root, 'linked'), /leaves/);
  } finally { await fs.rm(path.join(root, 'linked'), { force: true }); await fs.rm(outside, { recursive: true, force: true }); }
});

test('command protection keeps the checkout read-only and shell input a single argument', () => {
  const command = 'echo x > file; echo y';
  const args = protectedArgs('/tmp/repo', command);
  assert.ok(args.includes('--unshare-all'));
  assert.ok(args.includes('--ro-bind')); assert.ok(!args.includes('--bind'));
  assert.equal(args.at(-1), command);
  assert.deepEqual(args.slice(args.indexOf('--chdir'), args.indexOf('--chdir') + 2), ['--chdir', '/tmp/repo']);
});
