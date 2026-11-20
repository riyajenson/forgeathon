// Which workspace files the agent may see: not excluded by default, not ignored by any .gitignore, not a
// secret-looking file. One policy for listing, search, symbol lookup and the context index.
import type { EditorPort } from '../mcp/port';

export const MAX_INDEX_CHARS = 200_000;
/** Files requested from the editor per listing; more than this is reported as truncated, never silently dropped. */
export const LIST_LIMIT = 20_000;

const TEXT_EXT = new Set([
  'py', 'pyi', 'rst', 'md', 'txt', 'toml', 'cfg', 'ini', 'yaml', 'yml', 'json', 'html', 'jinja', 'j2', 'js', 'mjs', 'cjs',
  'ts', 'tsx', 'jsx', 'css', 'sh', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cs', 'rb', 'php', 'sql',
]);
/** Excluded even without a .gitignore: VCS data, dependencies, virtualenvs, caches and build output. */
export const DEFAULT_EXCLUDED_DIRS = new Set([
  '.git', '.hg', '.svn', 'node_modules', '.venv', 'venv', '__pycache__', '.tox', '.nox', '.mypy_cache', '.pytest_cache',
  '.ruff_cache', '.eggs', 'site-packages', 'htmlcov', 'dist', 'build', '.idea', '.vscode',
]);
const SKIP_FILES = new Set(['uv.lock', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'poetry.lock']);

export function isExcludedDir(name: string): boolean {
  return DEFAULT_EXCLUDED_DIRS.has(name) || name.endsWith('.egg-info');
}

/** Files that typically hold credentials. Never listed, searched, indexed or read for the model. */
export function isSecretPath(path: string): boolean {
  const name = (path.split('/').pop() ?? '').toLowerCase();
  return /^\.env(\..*)?$/.test(name) && name !== '.env.example' && name !== '.env.sample' && name !== '.env.template'
    || /\.(pem|key|p12|pfx|keystore|jks)$/.test(name)
    || /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/.test(name)
    || ['.netrc', '.npmrc', '.pypirc', '.git-credentials', 'credentials.json', 'secrets.json', 'secrets.yaml', 'secrets.yml'].includes(name);
}

export function isIndexable(path: string): boolean {
  const parts = path.split('/');
  if (parts.slice(0, -1).some(isExcludedDir)) return false;
  const name = parts[parts.length - 1] ?? '';
  if (SKIP_FILES.has(name)) return false;
  const dot = name.lastIndexOf('.');
  return dot > 0 && TEXT_EXT.has(name.slice(dot + 1).toLowerCase());
}

function globToRegex(glob: string): string {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*' && glob[i + 1] === '*') {
      // "**/" matches zero or more directories; a trailing "**" matches everything inside.
      if (glob[i + 2] === '/') { out += '(?:.*/)?'; i += 2; } else { out += '.*'; i += 1; }
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else if (c === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end < 0) { out += '\\['; continue; }
      out += `[${glob.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`;
      i = end;
    } else if (c === '\\' && i + 1 < glob.length) { out += glob[++i]!.replace(/[.+^${}()|[\]\\*?]/g, '\\$&'); }
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return out;
}

/** One .gitignore file: comments, escapes, negation, anchored and directory-only patterns, *, **, ? and [...]. */
export class GitIgnore {
  private readonly rules: Array<{ re: RegExp; negate: boolean; dirOnly: boolean }> = [];

  constructor(text: string) {
    for (const raw of text.split(/\r?\n/)) {
      let line = raw.replace(/(?<!\\)\s+$/, '');
      if (!line || line.startsWith('#')) continue;
      const negate = line.startsWith('!');
      if (negate) line = line.slice(1);
      if (line.startsWith('\\#') || line.startsWith('\\!')) line = line.slice(1);
      const dirOnly = line.endsWith('/');
      if (dirOnly) line = line.slice(0, -1);
      // A slash at the start or in the middle anchors the pattern to this .gitignore's directory.
      const anchored = line.includes('/');
      if (line.startsWith('/')) line = line.slice(1);
      if (!line) continue;
      this.rules.push({ re: new RegExp(`${anchored ? '^' : '(?:^|/)'}${globToRegex(line)}$`), negate, dirOnly });
    }
  }

  /** The last rule matching `rel` (relative to this file's directory): true = ignore, false = re-include, undefined = no rule. */
  decide(rel: string, isDir: boolean): boolean | undefined {
    let result: boolean | undefined;
    for (const r of this.rules) {
      if (r.dirOnly && !isDir) continue;
      if (r.re.test(rel)) result = !r.negate;
    }
    return result;
  }

  /** Single-file convenience: `path` is ignored by this file alone (git semantics: an ignored parent cannot be re-included). */
  ignores(path: string): boolean {
    return new IgnorePolicy(new Map([['', this]])).ignores(path);
  }
}

/** Every .gitignore in the workspace, applied like git: deeper files override shallower ones, last rule wins. */
export class IgnorePolicy {
  private readonly layers: Array<[string, GitIgnore]>;
  /** .gitignore files that exist but could not be read: exclusions they hold are unknown. */
  unreadable: string[] = [];

  constructor(byDir: Map<string, GitIgnore>) {
    this.layers = [...byDir.entries()].sort((a, b) => (a[0] ? a[0].split('/').length : 0) - (b[0] ? b[0].split('/').length : 0));
  }

  static async load(port: EditorPort, paths: readonly string[]): Promise<IgnorePolicy> {
    const byDir = new Map<string, GitIgnore>();
    const unreadable: string[] = [];
    // The root .gitignore is always tried, even if the listing left it out (origin 2395e27).
    const ignoreFiles = new Set(['.gitignore', ...paths.filter((p) => p.endsWith('/.gitignore'))]);
    for (const p of ignoreFiles) {
      let text: string | undefined;
      try { text = (await port.readText(p))?.text; } catch { unreadable.push(p); continue; }
      if (text !== undefined) byDir.set(p === '.gitignore' ? '' : p.slice(0, -'/.gitignore'.length), new GitIgnore(text));
    }
    const policy = new IgnorePolicy(byDir);
    policy.unreadable = unreadable;
    return policy;
  }

  private matches(path: string, isDir: boolean): boolean {
    let ignored = false;
    for (const [dir, gi] of this.layers) {
      if (dir && !path.startsWith(`${dir}/`)) continue;
      const decision = gi.decide(dir ? path.slice(dir.length + 1) : path, isDir);
      if (decision !== undefined) ignored = decision;
    }
    return ignored;
  }

  ignores(path: string): boolean {
    const parts = path.split('/');
    if (parts.slice(0, -1).some(isExcludedDir)) return true;
    // A file inside an ignored directory stays ignored whatever later rules say (git cannot re-include it).
    for (let i = 1; i < parts.length; i++) if (this.matches(parts.slice(0, i).join('/'), true)) return true;
    return this.matches(path, false);
  }
}

export interface VisibleFiles {
  files: string[];
  /** The editor's listing stopped at LIST_LIMIT; files after it were not considered. */
  truncated: boolean;
  /** .gitignore files that could not be read (their exclusions are unknown). */
  unreadableIgnores: string[];
}

/** Workspace files the agent may see, optionally under `prefix` (a directory or path prefix). */
export async function visibleFiles(port: EditorPort, prefix?: string): Promise<VisibleFiles> {
  const all = await port.listFiles({ limit: LIST_LIMIT });
  const policy = await IgnorePolicy.load(port, all);
  const files = all.filter((p) => (!prefix || p.startsWith(prefix)) && !policy.ignores(p) && !isSecretPath(p) &&
    !policy.unreadable.some((ignore) => ignore === '.gitignore' || p.startsWith(`${ignore.slice(0, -'/.gitignore'.length)}/`)));
  return { files, truncated: all.length >= LIST_LIMIT, unreadableIgnores: policy.unreadable };
}
