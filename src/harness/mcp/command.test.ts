import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type SpawnOptions } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { approvalKey, commandTestHooks, FakePort, isAutoApprovableCommand, isListedCommand, isTestCommand, runCommandTool, ScopeRegistry, type CommandRun, type SessionScope, type ToolContext } from './index';
import { checkProtection, confinedCwd, protectedArgs, systemMounts, venvBase } from './command-protection';
import { REDACTED } from './redact';
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

protectedTest('Stop after preparation, immediately before spawn: the command never starts', async () => {
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

protectedTest('cancel kills the whole process group, including background children', async () => {
  // The checkout is read-only, so the background child's survival is observed on stdout instead of a file.
  const args = { command: '(sleep 1; echo LATE_CHILD_OUTPUT) & sleep 30' };
  approve(args);
  const t0 = Date.now();
  const p = runCommandTool(ctx, args);
  setTimeout(() => scope.cancel(), 300);
  const r = await p;
  assert.ok(r.ok && /killed: turn cancelled/.test(r.text));
  assert.ok(r.ok && !/LATE_CHILD_OUTPUT/.test(r.text.slice(r.text.indexOf('--- stdout ---'))), 'the background child was killed too');
  assert.ok(Date.now() - t0 < 5000, 'returned promptly');
});

protectedTest('credential-like environment variables are withheld from the command', async () => {
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
  await fs.symlink(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
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

test('test runs (separate budget): listed pytest and python -m pytest, with or without a path or NAME=value prefix', () => {
  for (const c of ['pytest', 'pytest tests/test_cli.py -q', 'python -m pytest -q', 'python3.12 -m pytest tests', '.venv/bin/pytest -q',
    'PYTHONPATH=src pytest', 'python -m pytest "tests/test_cli.py::test_config"', '  pytest  ']) assert.equal(isTestCommand(c), true, c);
  for (const c of ['python -c "import flask"', 'flask --help', 'git diff', 'ls', 'pytest | tail -5', 'pytest && rm -rf x',
    'cd tests && pytest', 'pytestx', 'python -m pytestx', 'make test', 'tox']) assert.equal(isTestCommand(c), false, c);
});

protectedTest('a virtualenv outside the workspace under /tmp stays visible (read-only) to the command', async () => {
  const venv = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-venv-'));
  await fs.mkdir(path.join(venv, 'bin'));
  await fs.writeFile(path.join(venv, 'bin', 'python'), '#!/bin/sh\necho tmp-venv-python\n', { mode: 0o755 });
  const saved = { PATH: process.env['PATH'], VIRTUAL_ENV: process.env['VIRTUAL_ENV'] };
  process.env['PATH'] = `${path.join(venv, 'bin')}:${saved.PATH ?? ''}`;
  process.env['VIRTUAL_ENV'] = venv;
  try {
    const args = { command: 'python; touch "$VIRTUAL_ENV/written" 2>&1 || echo venv-read-only' };
    approve(args);
    const r = await runCommandTool(ctx, args);
    assert.ok(r.ok && /tmp-venv-python/.test(r.text), r.ok ? r.text : r.message);
    assert.ok(r.ok && /venv-read-only/.test(r.text));
    await assert.rejects(fs.access(path.join(venv, 'written')));
  } finally {
    process.env['PATH'] = saved.PATH;
    if (saved.VIRTUAL_ENV === undefined) delete process.env['VIRTUAL_ENV']; else process.env['VIRTUAL_ENV'] = saved.VIRTUAL_ENV;
    await fs.rm(venv, { recursive: true, force: true });
  }
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
    snapshot: async () => new Map(), environment: async () => ({ env: {}, removed: 0 }), checkProtection: async () => {},
    spawn: (() => { assert.fail('a cancelled or unprotected command must not spawn'); }) as CommandRuntime['spawn'],
  };
}

for (const step of ['snapshot', 'environment', 'checkProtection'] as const) {
  test(`cancellation during ${step} prevents spawn and releases controller`, async () => {
    const runtime = noSpawnRuntime();
    if (step === 'snapshot') runtime.snapshot = async () => { scope.cancel(); return new Map(); };
    if (step === 'environment') runtime.environment = async () => { scope.cancel(); return { env: {}, removed: 0 }; };
    if (step === 'checkProtection') runtime.checkProtection = async () => { scope.cancel(); };
    const args = { command: 'echo should-not-run' }; approve(args);
    const r = await runCommandTool(ctx, args, runtime);
    assert.ok(!r.ok && r.code === 'CANCELLED');
    assert.equal(scope.writes, 0); assert.equal(scope.running.size, 0);
  });
}

test('a file that still changed is reported as changed outside review (backstop)', async () => {
  let calls = 0;
  const runtime = noSpawnRuntime();
  runtime.snapshot = async () => (++calls === 1 ? new Map([['a.txt', 'M:1']]) : new Map([['a.txt', 'M:2'], ['b.txt', '??:3']]));
  runtime.spawn = (() => {
    const child = Object.assign(new EventEmitter(), { pid: 4242, stdout: new PassThrough(), stderr: new PassThrough() });
    setImmediate(() => child.emit('close', 0));
    return child;
  }) as unknown as CommandRuntime['spawn'];
  const args = { command: 'true' }; approve(args);
  const r = await runCommandTool(ctx, args, runtime);
  assert.ok(r.ok && /Files changed by the command \(outside review\): a\.txt, b\.txt/.test(r.text), r.ok ? r.text : r.message);
  assert.deepEqual(runs[0]!.changedFiles, ['a.txt', 'b.txt']);
  assert.equal(scope.writes, 1);
});

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

// Stand-in for bwrap in the race Stop used to lose: its "sandbox" (a setsid sleep) leaves the spawned process's group
// at once and keeps stdout/stderr open, as bwrap's sandbox process does before it has armed --die-with-parent. The
// stand-in reports the sandbox pid on fd 3 (bwrap's --info-fd) after `reportDelay` seconds.
function orphaningRuntime(pidFile: string, reportDelay: number): CommandRuntime {
  const runtime = noSpawnRuntime();
  runtime.environment = async () => ({ env: { PATH: process.env['PATH'] }, removed: 0 });
  runtime.spawn = ((_file: string, _args: readonly string[], options: SpawnOptions) => spawn('/bin/sh', ['-c',
    `setsid sleep 8 3>&- & echo $! > "${pidFile}"; sleep ${reportDelay}; ` +
    `{ printf '{"child-pid": %s}' $! >&3; } 2>/dev/null; exec 3>&-; wait`], options)) as unknown as CommandRuntime['spawn'];
  return runtime;
}

for (const [when, reportDelay] of [['after', 0], ['before', 0.5]] as const) {
  test(`Stop kills a sandbox that left bwrap's process group (Stop ${when} bwrap reported it)`, async () => {
    const pidFile = path.join(os.tmpdir(), `forge-orphan-${process.pid}-${reportDelay}`);
    await fs.rm(pidFile, { force: true });
    const args = { command: 'sleep 8' }; approve(args);
    const result = runCommandTool(ctx, args, orphaningRuntime(pidFile, reportDelay));
    let sandbox = 0;
    try {
      for (let i = 0; i < 300 && !sandbox; i++) {
        sandbox = Number(await fs.readFile(pidFile, 'utf8').catch(() => '0')) || 0;
        if (!sandbox) await new Promise((r) => setTimeout(r, 10));
      }
      assert.ok(sandbox > 0, 'the stand-in sandbox started');
      if (when === 'after') await new Promise((r) => setTimeout(r, 200));
      const t0 = Date.now();
      scope.cancel();
      const r = await result;
      const ms = Date.now() - t0;
      assert.ok(ms < 4000, `Stop ended the command in ${ms} ms, not when the 8 s sandbox finished`);
      assert.ok(r.ok && /killed: turn cancelled/.test(r.text), r.ok ? r.text : r.message);
      const gone = () => { try { process.kill(sandbox, 0); return false; } catch { return true; } };
      for (let i = 0; i < 100 && !gone(); i++) await new Promise((r) => setTimeout(r, 10));
      assert.ok(gone(), 'the sandbox process was killed');
    } finally {
      if (sandbox) { try { process.kill(sandbox, 'SIGKILL'); } catch { /* gone */ } }
      await result.catch(() => undefined);
      await fs.rm(pidFile, { force: true });
    }
  });
}

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
  assert.ok(!args.join(' ').includes('--ro-bind / /'), 'the host root is not mounted');
  assert.ok(!args.includes(os.homedir()), 'the home directory is not mounted');
  assert.equal(args.at(-1), command);
  assert.deepEqual(args.slice(args.indexOf('--chdir'), args.indexOf('--chdir') + 2), ['--chdir', '/tmp/repo']);
  const withVenv = protectedArgs('/tmp/repo', command, '/tmp/repo', ['/tmp/venv', 'relative/ignored', '/tmp/repo']);
  assert.equal(withVenv.join(' ').match(/--ro-bind-try \/tmp\/venv \/tmp\/venv/)?.length, 1, 'extra paths are read-only, optional binds');
  assert.ok(!withVenv.includes('relative/ignored'));
  assert.ok(!withVenv.includes('--bind'));
});

test('only the system runtime is mounted besides the workspace: merged-/usr links stay links, no /home or /opt', () => {
  const m = systemMounts().join(' ');
  assert.match(m, /--ro-bind \/usr \/usr/);
  assert.match(m, /--ro-bind \/etc \/etc/);
  assert.ok(!/\/home|\/root|\/opt|\/var/.test(m), m);
  const hidden = protectedArgs('/w', 'true', '/w', [], ['/w/config/models.json', '/elsewhere/models.json'], []);
  assert.equal(hidden.join(' ').match(/--ro-bind-try \/dev\/null \/w\/config\/models\.json/)?.length, 1, 'hidden files inside the workspace are covered');
  assert.ok(!hidden.includes('/elsewhere/models.json'), 'paths outside the workspace are not mounted at all');
});

test('a virtualenv\'s base interpreter outside the system runtime is made visible; a system one is not', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-venv-'));
  try {
    const base = path.join(dir, 'cpython-3.12'); await fs.mkdir(path.join(base, 'bin'), { recursive: true });
    const venv = path.join(dir, 'venv'); await fs.mkdir(venv);
    await fs.writeFile(path.join(venv, 'pyvenv.cfg'), `home = ${path.join(base, 'bin')}\nversion = 3.12.0\n`);
    assert.equal(venvBase(venv), await fs.realpath(base));
    await fs.writeFile(path.join(venv, 'pyvenv.cfg'), 'home = /usr/bin\n');
    assert.equal(venvBase(venv), undefined);
    assert.equal(venvBase(path.join(dir, 'missing')), undefined);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

protectedTest('confidentiality: a key file in the home directory cannot be read, and ~/.ssh does not exist inside', async () => {
  const fake = 'nvapi-SANDBOXTESTFAKEKEY0123456789';
  const secretFile = path.join(os.homedir(), `.forge-sandbox-test-${process.pid}.env`);
  await fs.writeFile(secretFile, `NVIDIA_API_KEY=${fake}\nPLAIN_MARKER_7f3a\n`, { mode: 0o600 });
  try {
    const command = `cat ${secretFile}; ls -A ${os.homedir()}; test -e ${path.join(os.homedir(), '.ssh')} && echo HAS_SSH || echo NO_SSH`;
    approve({ command });
    const r = await runCommandTool(ctx, { command });
    assert.ok(r.ok);
    const text = r.ok ? r.text.slice(r.text.indexOf('--- stdout ---')) : '';
    assert.ok(!text.includes('PLAIN_MARKER_7f3a'), 'the key file was not readable');
    assert.ok(!text.includes(fake));
    const stdout = text.slice(0, text.indexOf('--- stderr ---'));
    assert.ok(!stdout.includes(path.basename(secretFile)), 'the home directory listing (stdout) does not show it');
    assert.match(text, /No such file or directory/);
    assert.match(text, /NO_SSH/);
  } finally { await fs.rm(secretFile, { force: true }); }
});

protectedTest('confidentiality: an echoed key and a configured provider key are redacted before the model, the turn or the panel see them', async () => {
  const provider = 'zq-provider-value-0123456789';
  process.env['FORGE_TEST_PROVIDER_API_KEY'] = provider;
  try {
    const fake = 'sk-or-v1-0123456789abcdef0123456789abcdef';
    const command = `echo token ${fake}; echo provider ${provider} >&2`;
    approve({ command });
    const r = await runCommandTool(ctx, { command });
    assert.ok(r.ok);
    const text = r.ok ? r.text : '';
    assert.ok(!text.includes(fake) && !text.includes(provider), 'neither in the output nor in the echoed command');
    assert.match(text, new RegExp(`token \\${REDACTED.slice(0, -1)}\\]`));
    assert.match(text, /provider \[REDACTED\]/);
    assert.match(text, /output: 2 secret-like value\(s\) redacted/);
    assert.ok(!runs[0]!.output!.includes(fake) && !runs[0]!.output!.includes(provider), 'the turn (test outcome, logs) gets redacted output');
  } finally { delete process.env['FORGE_TEST_PROVIDER_API_KEY']; }
});

protectedTest('a hidden file inside the workspace reads as empty in the sandbox', async () => {
  await fs.mkdir(path.join(root, 'config'), { recursive: true });
  const cfg = path.join(root, 'config', 'models.json');
  await fs.writeFile(cfg, '{"apiKeyEnv": "X", "marker": "HIDDEN_MARKER"}');
  try {
    const out = execFileSync('bwrap', protectedArgs(root, 'cat config/models.json; echo END', root, [], [cfg]), { encoding: 'utf8' });
    assert.equal(out.trim(), 'END');
  } finally { await fs.rm(path.join(root, 'config'), { recursive: true, force: true }); }
});
