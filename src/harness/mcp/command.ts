// run_command: executes one approved shell command inside the workspace and reports what it changed.
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

function capped(buf: string): string {
  return buf.length <= COMMAND_OUTPUT_CAP ? buf : `${buf.slice(0, COMMAND_OUTPUT_CAP / 2)}\n[... ${buf.length - COMMAND_OUTPUT_CAP} characters omitted ...]\n${buf.slice(-COMMAND_OUTPUT_CAP / 2)}`;
}

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
  const cwd = rel ? path.join(root, ...rel.split('/')) : root;
  const timeoutSec = Math.min(Math.max(1, Math.floor(args.timeout_sec ?? COMMAND_DEFAULT_TIMEOUT_SEC)), COMMAND_MAX_TIMEOUT_SEC);

  const before = await snapshot(root);
  scope.writes++; // a shell command may change anything: never retry or fall back after one ran
  const controller = new AbortController();
  scope.running.add(controller);
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  const exitCode = await new Promise<number | null>((resolve) => {
    const child = spawn('bash', ['-c', args.command], { cwd, env: process.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const killGroup = (signal: NodeJS.Signals) => { try { if (child.pid) process.kill(-child.pid, signal); } catch { /* already gone */ } };
    const stop = () => { killGroup('SIGTERM'); setTimeout(() => killGroup('SIGKILL'), 2000).unref(); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutSec * 1000);
    controller.signal.addEventListener('abort', stop);
    child.stdout.on('data', (c: Buffer) => { if (stdout.length < COMMAND_OUTPUT_CAP * 4) stdout += c.toString('utf8'); });
    child.stderr.on('data', (c: Buffer) => { if (stderr.length < COMMAND_OUTPUT_CAP * 4) stderr += c.toString('utf8'); });
    child.on('error', (e) => { stderr += `\n${e.message}`; });
    child.on('close', (code) => { clearTimeout(timer); resolve(code); });
  });
  scope.running.delete(controller);
  const after = await snapshot(root);
  const changedFiles = before && after ? diffSnapshots(before, after) : [];
  scope.onCommand?.({ callRef: approval.callRef, command: args.command, exitCode, changedFiles });

  const stopped = controller.signal.aborted ? ' (killed: turn cancelled)' : timedOut ? ` (killed: exceeded ${timeoutSec} s)` : '';
  const changes = before && after
    ? changedFiles.length ? `Files changed by the command: ${changedFiles.join(', ')}` : 'Files changed by the command: none'
    : 'Files changed by the command: unknown (not a git repository)';
  const unsaved = scope.unsavedPaths.size
    ? `\nWarning: unsaved editor changes are not visible to this command: ${[...scope.unsavedPaths].join(', ')}`
    : '';
  return {
    ok: true,
    text: `$ ${args.command}\ncwd: ${rel || '.'}\nexit code: ${exitCode ?? 'none'}${stopped}\n${changes}${unsaved}\n--- stdout ---\n${capped(stdout)}\n--- stderr ---\n${capped(stderr)}`,
  };
}
