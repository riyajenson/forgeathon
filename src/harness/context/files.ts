// Which workspace files are worth indexing: text files, not ignored, not huge.

export const MAX_INDEX_CHARS = 200_000;

const TEXT_EXT = new Set([
  'py', 'pyi', 'rst', 'md', 'txt', 'toml', 'cfg', 'ini', 'yaml', 'yml', 'json', 'html', 'jinja', 'j2', 'js', 'mjs', 'cjs',
  'ts', 'tsx', 'jsx', 'css', 'sh', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cs', 'rb', 'php', 'sql',
]);
const ALWAYS_SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.tox', '.mypy_cache', '.pytest_cache', 'dist', 'build', '.idea', '.vscode']);
const SKIP_FILES = new Set(['uv.lock', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'poetry.lock']);

export function isIndexable(path: string): boolean {
  const parts = path.split('/');
  if (parts.slice(0, -1).some((p) => ALWAYS_SKIP_DIRS.has(p) || p.endsWith('.egg-info'))) return false;
  const name = parts[parts.length - 1] ?? '';
  if (SKIP_FILES.has(name)) return false;
  const dot = name.lastIndexOf('.');
  return dot > 0 && TEXT_EXT.has(name.slice(dot + 1).toLowerCase());
}

/** Minimal .gitignore matcher: comments, negation, anchored and directory patterns, *, ** and ?. */
export class GitIgnore {
  private readonly rules: Array<{ re: RegExp; negate: boolean; dirOnly: boolean }> = [];

  constructor(text: string) {
    for (const raw of text.split(/\r?\n/)) {
      let line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const negate = line.startsWith('!');
      if (negate) line = line.slice(1);
      const dirOnly = line.endsWith('/');
      if (dirOnly) line = line.slice(0, -1);
      const anchored = line.startsWith('/') || line.includes('/');
      if (line.startsWith('/')) line = line.slice(1);
      const body = line
        .split('**')
        .map((seg) => seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]'))
        .join('.*');
      const re = new RegExp(`${anchored ? '^' : '(^|/)'}${body}(/|$)`);
      this.rules.push({ re, negate, dirOnly });
    }
  }

  ignores(path: string): boolean {
    let ignored = false;
    for (const r of this.rules) {
      const m = r.re.exec(path);
      if (!m) continue;
      // A directory-only rule must match a directory prefix, not the file name itself.
      if (r.dirOnly && m.index + m[0].length >= path.length && !m[0].endsWith('/')) continue;
      ignored = !r.negate;
    }
    return ignored;
  }
}
