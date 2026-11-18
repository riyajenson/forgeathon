// EditorPort backed by a plain directory. Used by tests and headless runs; not the extension's implementation.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { sha256Hex } from '../review';
import { normalizeWorkspacePath } from './paths';
import type { ApplyTextRequest, ApplyTextResult, EditorPort, ListFilesOptions, TextSnapshot } from './port';

const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build']);

export class FakePort implements EditorPort {
  readonly writes: ApplyTextRequest[] = [];
  readonly logs: string[] = [];

  constructor(readonly root: string) {}

  private abs(rel: string): string | null {
    const norm = normalizeWorkspacePath(rel);
    return norm ? path.join(this.root, ...norm.split('/')) : null;
  }

  async readText(rel: string): Promise<TextSnapshot | null> {
    const file = this.abs(rel);
    if (!file) return null;
    try {
      const text = await fs.readFile(file, 'utf8');
      return { text, sha256: sha256Hex(text) };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT' || (e as NodeJS.ErrnoException).code === 'EISDIR') return null;
      throw e;
    }
  }

  async listFiles(options?: ListFilesOptions): Promise<string[]> {
    const out: string[] = [];
    const limit = options?.limit ?? Infinity;
    const walk = async (dir: string, rel: string): Promise<void> => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const ent of entries) {
        if (out.length >= limit) return;
        const childRel = rel ? `${rel}/${ent.name}` : ent.name;
        if (ent.isDirectory()) {
          if (!SKIP_DIRS.has(ent.name)) await walk(path.join(dir, ent.name), childRel);
        } else if (ent.isFile() && (!options?.prefix || childRel.startsWith(options.prefix))) {
          out.push(childRel);
        }
      }
    };
    await walk(this.root, '');
    return out;
  }

  async applyText(req: ApplyTextRequest): Promise<ApplyTextResult> {
    const file = this.abs(req.path);
    if (!file) return { ok: false, code: 'OUTSIDE_WORKSPACE', message: `refusing to write ${req.path}` };
    const current = await this.readText(req.path);
    const currentSha = current ? current.sha256 : null;
    if (currentSha !== req.expectedSha256) {
      return { ok: false, code: 'STALE_BASE', message: `${req.path} changed (expected ${req.expectedSha256}, found ${currentSha})` };
    }
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, req.newText, 'utf8');
    } catch (e) {
      return { ok: false, code: 'WRITE_FAILED', message: (e as Error).message };
    }
    this.writes.push(req);
    return { ok: true, preSha256: currentSha, postSha256: sha256Hex(req.newText) };
  }

  log(level: 'info' | 'warn' | 'error', message: string): void {
    this.logs.push(`${level}: ${message}`);
  }
}
