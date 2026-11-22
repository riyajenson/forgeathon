import { execFile } from 'node:child_process';
import { lstatSync, readFileSync, readlinkSync, realpathSync, promises as fs } from 'node:fs';
import path from 'node:path';

export async function confinedCwd(root: string, relative: string): Promise<string> {
  const base = await fs.realpath(root);
  const cwd = await fs.realpath(path.join(base, relative));
  const rel = path.relative(base, cwd);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error('Command working directory leaves the workspace.');
  if (!(await fs.stat(cwd)).isDirectory()) throw new Error('Command working directory is not a directory.');
  return cwd;
}

export const PROTECTION_HELP = 'Verification requires Linux/WSL with bubblewrap and user namespaces enabled. Install bubblewrap in that environment and retry; unrestricted shell execution is disabled.';

/** The system runtime a command may see (read-only); nothing else of the host is mounted: no /home, /root, /opt or /var. */
export const SYSTEM_RUNTIME = ['/usr', '/bin', '/sbin', '/lib', '/lib32', '/lib64', '/libx32', '/etc'] as const;

/** Mounts for the system runtime: merged-/usr symlinks (/bin -> usr/bin) are recreated as symlinks, directories bound read-only. */
export function systemMounts(): string[] {
  return SYSTEM_RUNTIME.flatMap((p) => {
    try {
      if (lstatSync(p).isSymbolicLink()) return ['--symlink', readlinkSync(p), p];
      return ['--ro-bind', p, p];
    } catch { return []; }
  });
}

/**
 * Only the system runtime, the workspace and `visible` paths (a virtualenv and its base interpreter) are mounted,
 * all read-only: the home directory, SSH keys, provider configs and other checkouts do not exist inside.
 * `hidden` paths inside the workspace (e.g. this repo's config/models.json) are covered by an empty file.
 * Test scratch files go to a private /tmp. No network, no capabilities, a new session.
 */
export function protectedArgs(cwd: string, command: string, workspaceRoot = cwd, visible: readonly string[] = [], hidden: readonly string[] = [], system: readonly string[] = systemMounts()): string[] {
  const extra = [...new Set(visible.filter((p) => path.isAbsolute(p) && p !== workspaceRoot))];
  const inside = (p: string) => p === workspaceRoot || p.startsWith(workspaceRoot + path.sep);
  return ['--die-with-parent', '--unshare-all', '--new-session', '--cap-drop', 'ALL',
    ...system, '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
    // A checkout (or virtualenv) under /tmp must remain visible and read-only after that mount.
    '--ro-bind', workspaceRoot, workspaceRoot, ...extra.flatMap((p) => ['--ro-bind-try', p, p]),
    ...hidden.filter((p) => path.isAbsolute(p) && inside(p)).flatMap((p) => ['--ro-bind-try', '/dev/null', p]),
    '--chdir', cwd, '--', '/bin/bash', '--noprofile', '--norc', '-c', command];
}

/**
 * The installation a virtualenv's interpreter comes from (pyvenv.cfg `home`, e.g. ~/.local/share/uv/python/
 * cpython-3.12/bin): its prefix must be visible for the venv to run. Nothing when it is part of the system runtime.
 */
export function venvBase(venv: string): string | undefined {
  try {
    const home = /^home\s*=\s*(.+)$/m.exec(readFileSync(path.join(venv, 'pyvenv.cfg'), 'utf8'))?.[1]?.trim();
    if (!home) return undefined;
    const real = realpathSync(home);
    const prefix = path.basename(real) === 'bin' ? path.dirname(real) : real;
    const system = SYSTEM_RUNTIME.some((s) => prefix === s || prefix.startsWith(s + '/')) || prefix === '/';
    return system ? undefined : prefix;
  } catch { return undefined; }
}

export async function checkProtection(cwd: string, signal: AbortSignal): Promise<void> {
  if (process.platform !== 'linux') throw new Error(PROTECTION_HELP);
  await new Promise<void>((resolve, reject) => {
    execFile('bwrap', protectedArgs(cwd, 'true'), { signal, timeout: 5000 }, (error) => {
      if (error) reject(new Error(PROTECTION_HELP)); else resolve();
    });
  });
}
