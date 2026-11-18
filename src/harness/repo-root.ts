import { existsSync } from 'node:fs';
import path from 'node:path';

/** The repository root: the nearest ancestor of `from` that contains agent/ and contracts/. */
export function repoRoot(from: string = __dirname): string {
  let dir = path.resolve(from);
  for (;;) {
    if (existsSync(path.join(dir, 'agent')) && existsSync(path.join(dir, 'contracts'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`cannot find the repository root above ${from}`);
    dir = parent;
  }
}
