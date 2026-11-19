import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
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

/** The host filesystem (including the live checkout) is read-only. Test scratch files are disposable. */
export function protectedArgs(cwd: string, command: string, workspaceRoot = cwd): string[] {
  return ['--die-with-parent', '--unshare-all', '--new-session', '--cap-drop', 'ALL',
    '--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--tmpfs', '/run',
    // A checkout under /tmp or /run must remain visible and read-only after those mounts.
    '--ro-bind', workspaceRoot, workspaceRoot, '--chdir', cwd, '--', '/bin/bash', '--noprofile', '--norc', '-c', command];
}

export async function checkProtection(cwd: string, signal: AbortSignal): Promise<void> {
  if (process.platform !== 'linux') throw new Error(PROTECTION_HELP);
  await new Promise<void>((resolve, reject) => {
    execFile('bwrap', protectedArgs(cwd, 'true'), { signal, timeout: 5000 }, (error) => {
      if (error) reject(new Error(PROTECTION_HELP)); else resolve();
    });
  });
}
