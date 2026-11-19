import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

// Never walked: VCS data, dependencies, virtualenvs, caches, build output (the harness applies .gitignore on top).
const excluded = new Set(['.git', '.hg', '.svn', 'node_modules', '.venv', 'venv', '__pycache__', '.tox', '.nox', '.mypy_cache',
  '.pytest_cache', '.ruff_cache', '.eggs', 'site-packages', 'htmlcov', 'dist', 'build']);

function relativePath(input: string): string {
  const parts = input.split('/');
  if (!input || input.startsWith('/') || /[\\:\0]/.test(input) ||
      parts.some(p => p === '..' || p.toLowerCase() === '.git' || p.toLowerCase() === 'node_modules' ||
        (process.platform === 'win32' && p !== '.' && (/[. ]$/.test(p) || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(p))))) {
    throw new Error('Invalid workspace-relative path');
  }
  return parts.filter(p => p && p !== '.').join('/');
}

function contains(root: string, file: string): boolean {
  const rel = path.relative(root, file);
  return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

function snapshot(text: string) {
  return { text, sha256: createHash('sha256').update(text, 'utf8').digest('hex') };
}

// Bound to the workspace host filesystem, including Linux when running in Remote-WSL.
export function createReader(folder: vscode.WorkspaceFolder) {
  return async function readText(input: string) {
    if (!vscode.workspace.isTrusted) throw new Error('Workspace trust required');
    const rel = relativePath(input);
    if (!rel) throw new Error('Expected a file');
    const root = await fs.realpath(folder.uri.fsPath);
    const file = path.join(root, rel);
    const uri = vscode.Uri.joinPath(folder.uri, rel);
    const live = () => vscode.workspace.textDocuments.find(d => d.uri.toString() === uri.toString());
    try {
      // Refuse symlinks or junctions at any component before using the file.
      let component = root;
      for (const part of rel.split('/')) {
        component = path.join(component, part);
        if ((await fs.lstat(component)).isSymbolicLink()) throw new Error('Linked paths are not supported');
      }
      const doc = live();
      if (doc) return snapshot(doc.getText());
      if (!(await fs.stat(file)).isFile()) throw new Error('Expected a regular file');
      const handle = await fs.open(file, 'r');
      try {
        const actual = await fs.realpath(file);
        if (!contains(root, actual)) throw new Error('Outside workspace');
        const opened = await handle.stat({ bigint: true });
        const checked = await fs.stat(actual, { bigint: true });
        if (!opened.isFile() || opened.dev !== checked.dev || opened.ino !== checked.ino) {
          throw new Error('File changed during open');
        }
        const text = await handle.readFile('utf8');
        return snapshot(live()?.getText() ?? text);
      } finally { await handle.close(); }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      const doc = live();
      return doc ? snapshot(doc.getText()) : null;
    }
  };
}

export function createFileLister(folder: vscode.WorkspaceFolder) {
  return async function listFiles(options: { prefix?: string; limit?: number } = {}) {
    if (!vscode.workspace.isTrusted) throw new Error('Workspace trust required');
    const limit = Math.min(options.limit ?? 500, 20000);
    if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('Invalid file limit');
    const raw = options.prefix ?? '';
    const normalized = raw ? relativePath(raw) : '';
    const prefix = normalized && raw.endsWith('/') ? normalized + '/' : normalized;
    const root = await fs.realpath(folder.uri.fsPath);
    const files: string[] = [];
    async function walk(dir: string, parent: string): Promise<void> {
      if (files.length >= limit) return;
      if (!contains(root, await fs.realpath(dir))) throw new Error('Outside workspace');
      const entries = await fs.opendir(dir);
      for await (const entry of entries) {
        const rel = parent + entry.name;
        if (entry.isDirectory() && !excluded.has(entry.name.toLowerCase()) && !entry.name.endsWith('.egg-info') &&
            (prefix.startsWith(rel + '/') || rel.startsWith(prefix))) {
          await walk(path.join(dir, entry.name), rel + '/');
        } else if (entry.isFile() && rel.startsWith(prefix)) {
          files.push(rel);
        }
        if (files.length >= limit) break;
      }
    }
    await walk(root, '');
    return files.sort();
  };
}

// Only known status labels may enter the log. Arbitrary harness text may contain source or keys.
const safeStatuses = new Set(['starting', 'running', 'awaiting_review', 'retrying', 'fallback',
  'compacting', 'cancelling', 'cancelled', 'done', 'error']);
export function createStatusLogger() {
  const channel = vscode.window.createOutputChannel('Forge-a-thon');
  return {
    log(level: 'info' | 'warn' | 'error', message: string) {
      channel.appendLine(JSON.stringify({ level, status: safeStatuses.has(message) ? message : 'harness_message' }));
    },
    dispose() { channel.dispose(); }
  };
}
