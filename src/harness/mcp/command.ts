// run_command: executes one approved shell command inside the workspace and reports what it changed.
// It is not a sandbox: an approved command can change files without hunk review. Mitigations: exact
// one-use approval, real-path cwd containment, a scrubbed environment, a timeout and an output cap, an
// "unrestricted" warning for commands outside a small verification list, and a git status diff of what
// the command changed.
import { execFile, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { sha256Hex } from '../review';
import { normalizeWorkspacePath } from './paths';
import type { ToolContext, ToolOutcome } from './tools';
import { approvalKey } from './tools';

export interface RunCommandArgs {
  command: string;
  cwd?: string | undefined;
  timeout_sec?: number | undefined;
}

export const COMMAND_OUTPUT_CAP = 20_000;
export const COMMAND_DEFAULT_TIMEOUT_SEC = 120;
export const COMMAND_MAX_TIMEOUT_SEC = 600;

/** Test hook: runs after the command is prepared, immediately before the final cancel check and spawn. */
export const commandTestHooks: { beforeSpawn?: (() => void) | undefined } = {};

/** path → "<porcelain status>:<content sha>" for every file git reports as changed or untracked. */
async function snapshot(root: string): Promise<Map<string, string> | null> {
  const porcelain = await new Promise<string | null>((resolve) => {
    execFile('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: root, timeout: 15000, maxBuffer: 16 * 1024 * 1024 }, (e, out) => resolve(e ? null : out));
  });
  if (porcelain === null) return null;
  const map = new Map<string, string>();
  const entries = porcelain.split('\0');
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (entry.length < 4) continue;
    const status = entry.slice(0, 2);
    const file = entry.slice(3);
    if (status[0] === 'R' || status[0] === 'C') i++; // rename/copy: next entry is the source path
    let digest = 'absent';
    try {
      digest = sha256Hex(await fs.readFile(path.join(root, file), 'utf8'));
    } catch {
      // deleted or unreadable
    }
    map.set(file, `${status}:${digest}`);
  }
  return map;
}

function diffSnapshots(before: Map<string, string>, after: Map<string, string>): string[] {
  const changed = new Set<string>();
  for (const [file, v] of after) if (before.get(file) !== v) changed.add(file);
  for (const file of before.keys()) if (!after.has(file)) changed.add(file);
  return [...changed].sort();
}

/** Environment variables a command never receives: anything that looks like a credential, and editor IPC handles. */
const SECRET_ENV = /KEY|TOKEN|SECRET|PASSW|CREDENTIAL|AUTH|COOKIE|PRIVATE|SESSION/i;
const EDITOR_IPC_ENV = /^VSCODE_(IPC|GIT)|^GIT_ASKPASS$|^SSH_ASKPASS$/;

/** The editor's environment without secrets, with the workspace's own virtualenv (.venv or venv) first on PATH. */
export async function commandEnv(root: string): Promise<{ env: NodeJS.ProcessEnv; removed: number }> {
  const env: NodeJS.ProcessEnv = {};
  let removed = 0;
  for (const [k, v] of Object.entries(process.env)) {
    if (SECRET_ENV.test(k) || EDITOR_IPC_ENV.test(k)) removed++;
    else env[k] = v;
  }
  for (const dir of ['.venv', 'venv']) {
    const bin = path.join(root, dir, 'bin');
    try {
      await fs.access(path.join(bin, 'python'));
      return { env: { ...env, VIRTUAL_ENV: path.join(root, dir), PATH: `${bin}${path.delimiter}${env['PATH'] ?? ''}` }, removed };
    } catch {
      // no virtualenv here
    }
  }
  return { env, removed };
}

const VERIFICATION_COMMANDS = [
  /^(?:[\w./-]*\/)?python3?(?:\.\d+)? -m pytest(?: |$)/,
  /^(?:[\w./-]*\/)?pytest(?: |$)/,
  /^(?:[\w./-]*\/)?python3?(?:\.\d+)? -c /,
  /^(?:[\w./-]*\/)?flask(?: |$)/,
  /^git (?:status|diff)(?: |$)/,
];

/**
 * True for the verification commands the agents are expected to run (pytest, python -m pytest, python -c,
 * flask, git status, git diff), optionally after NAME=value assignments, with no shell operators outside quotes.
 * Anything else is "unrestricted" and the approval prompt says so. This is a label for the reviewer, not a sandbox.
 */
export function isListedCommand(command: string): boolean {
  let c = command.trim();
  if (/--output\b|--ext-diff/.test(c)) return false;
  // Quoted strings are arguments; outside them, any shell operator makes the command unrestricted.
  const bare = c.replace(/'[^']*'/g, "''").replace(/"(?:[^"\\$`]|\\.)*"/g, '""');
  if (/[;&|<>`$(){}\n\\*?]/.test(bare.replace(/''|""/g, ''))) return false;
  c = c.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|[^\s'"]*)\s+)+/, '');
  return VERIFICATION_COMMANDS.some((re) => re.test(c));
}

export const UNRESTRICTED_WARNING = 'Unrestricted command: it can change any file without hunk review and is not sandboxed.';

function capped(buf: string): string {
  return buf.length <= COMMAND_OUTPUT_CAP ? buf : `${buf.slice(0, COMMAND_OUTPUT_CAP / 2)}\n[... ${buf.length - COMMAND_OUTPUT_CAP} characters omitted ...]\n${buf.slice(-COMMAND_OUTPUT_CAP / 2)}`;
}

const cancelled = (): ToolOutcome => ({ ok: false, code: 'CANCELLED', message: 'the turn was cancelled before the command started; nothing was run' });

export async function runCommandTool(ctx: ToolContext, args: RunCommandArgs): Promise<ToolOutcome> {
  const scope = ctx.scope;
  if (!scope) return { ok: false, code: 'NO_REVIEW_DECISION', message: 'this call is not bound to an active turn; nothing was run' };
  if (scope.cancelled) return { ok: false, code: 'CANCELLED', message: 'the turn was cancelled; nothing was run' };
  const approval = scope.commands.take(approvalKey('run_command', args));
  if (!approval) return { ok: false, code: 'NO_REVIEW_DECISION', message: 'the user has not approved this exact command; nothing was run' };
  const root = scope.workspaceRoot;
  if (!root) return { ok: false, code: 'INVALID_ARGS', message: 'no workspace root is known for this session' };
  const rel = args.cwd === undefined || args.cwd === '' || args.cwd === '.' ? '' : normalizeWorkspacePath(args.cwd);
  if (rel === null) return { ok: false, code: 'OUTSIDE_WORKSPACE', message: `cwd must be inside the workspace: ${args.cwd}` };
  const timeoutSec = Math.min(Math.max(1, Math.floor(args.timeout_sec ?? COMMAND_DEFAULT_TIMEOUT_SEC)), COMMAND_MAX_TIMEOUT_SEC);

  // Registered before the first await, so a cancel at any point from here on is seen.
  const controller = new AbortController();
  scope.running.add(controller);
  try {
    let cwd: string;
    try {
      const realRoot = await fs.realpath(root);
      cwd = await fs.realpath(rel ? path.join(root, ...rel.split('/')) : root);
      const inside = path.relative(realRoot, cwd);
      if (inside.startsWith('..') || path.isAbsolute(inside)) {
        return { ok: false, code: 'OUTSIDE_WORKSPACE', message: `cwd resolves outside the workspace (symlink?): ${args.cwd}; nothing was run` };
      }
      if (!(await fs.stat(cwd)).isDirectory()) return { ok: false, code: 'INVALID_ARGS', message: `cwd is not a directory: ${args.cwd}; nothing was run` };
    } catch {
      return { ok: false, code: 'INVALID_ARGS', message: `cwd does not exist: ${args.cwd}; nothing was run` };
    }
    const before = await snapshot(root);
    const { env, removed } = await commandEnv(root);
    commandTestHooks.beforeSpawn?.();
    // Last check, synchronously before spawn: nothing below awaits until the process exists and is killable.
    if (scope.cancelled || controller.signal.aborted) return cancelled();
    scope.writes++; // a shell command may change anything: never retry or fall back after one ran

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const exitCode = await new Promise<number | null>((resolve) => {
      const child = spawn('bash', ['-c', args.command], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const killGroup = (signal: NodeJS.Signals) => { try { if (child.pid) process.kill(-child.pid, signal); } catch { /* already gone */ } };
      const stop = () => { killGroup('SIGTERM'); setTimeout(() => killGroup('SIGKILL'), 2000).unref(); };
      const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutSec * 1000);
      controller.signal.addEventListener('abort', stop);
      child.stdout.on('data', (c: Buffer) => { if (stdout.length < COMMAND_OUTPUT_CAP * 4) stdout += c.toString('utf8'); });
      child.stderr.on('data', (c: Buffer) => { if (stderr.length < COMMAND_OUTPUT_CAP * 4) stderr += c.toString('utf8'); });
      child.on('error', (e) => { stderr += `\n${e.message}`; });
      child.on('close', (code) => { clearTimeout(timer); controller.signal.removeEventListener('abort', stop); resolve(code); });
    });
    const after = await snapshot(root);
    const changedFiles = before && after ? diffSnapshots(before, after) : [];
    scope.onCommand?.({ callRef: approval.callRef, command: args.command, exitCode, changedFiles });

    const stopped = controller.signal.aborted ? ' (killed: turn cancelled)' : timedOut ? ` (killed: exceeded ${timeoutSec} s)` : '';
    const changes = before && after
      ? changedFiles.length ? `Files changed by the command (outside review): ${changedFiles.join(', ')}` : 'Files changed by the command: none'
      : 'Files changed by the command: unknown (not a git repository)';
    const unsaved = scope.unsavedPaths.size
      ? `\nWarning: unsaved editor changes are not visible to this command: ${[...scope.unsavedPaths].join(', ')}`
      : '';
    const scrubbed = removed ? `\nenvironment: ${removed} credential-like variable(s) withheld` : '';
    return {
      ok: true,
      text: `$ ${args.command}\ncwd: ${rel || '.'}\nexit code: ${exitCode ?? 'none'}${stopped}\n${changes}${unsaved}${scrubbed}\n--- stdout ---\n${capped(stdout)}\n--- stderr ---\n${capped(stderr)}`,
    };
  } finally {
    scope.running.delete(controller);
  }
}
