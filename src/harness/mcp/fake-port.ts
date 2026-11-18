// EditorBridge backed by a plain directory. Used by tests and headless runs; not the extension's implementation.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ApplyTextRequest, ApplyTextResult, EditorBridge, ListFilesOptions } from '../contract-types';
import { sha256Hex } from '../review';
import { normalizeWorkspacePath } from './paths';
import type { TextSnapshot } from './port';

const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build']);

/** How the fake editor behaves on applyText; 'save' is the normal apply-then-save flow. */
export type FakeApplyMode = 'save' | 'defer' | 'save_fail' | 'throw';

export class FakePort implements EditorBridge {
  readonly applies: ApplyTextRequest[] = [];
  readonly logs: string[] = [];
  mode: FakeApplyMode = 'save';
  /** Simulates a save participant (e.g. a formatter) transforming the text on save. */
  formatOnSave: ((text: string) => string) | undefined;
  private undoSeq = 0;

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
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'EISDIR') return null;
      throw e;
    }
  }

  async listFiles(options?: ListFilesOptions): Promise<readonly string[]> {
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
    if (this.mode === 'throw') throw new Error('simulated editor failure');
    const base = { sessionId: req.sessionId, turnId: req.turnId, callId: req.callId, proposalId: req.proposalId, path: req.path };
    const file = this.abs(req.path);
    if (!file) return { ...base, status: 'failed_before_apply', message: 'path outside workspace' };
    if (sha256Hex(req.text) !== req.textSha256) return { ...base, status: 'failed_before_apply', message: 'text does not match textSha256' };
    const current = await this.readText(req.path);
    const observed = current ? current.sha256 : null;
    if (observed !== req.expectedSha256) return { ...base, status: 'stale', expectedSha256: req.expectedSha256, observedSha256: observed };

    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, req.text, 'utf8');
    this.applies.push(req);
    const applied = { appliedHunkIds: [...req.acceptedHunkIds], undo: { undoId: `undo-${++this.undoSeq}`, path: req.path, expectedPostSha256: req.textSha256 } };
    if (this.mode === 'defer') return { ...base, ...applied, status: 'buffer_applied', save: 'deferred', reason: 'document had unrelated unsaved changes' };
    if (this.mode === 'save_fail') {
      return { ...base, ...applied, status: 'save_failed', message: 'disk full', currentBufferSha256: req.textSha256, disk: 'unknown', recovery: 'inspect_buffer_then_retry_save' };
    }
    const saved = this.formatOnSave ? this.formatOnSave(req.text) : req.text;
    if (saved !== req.text) await fs.writeFile(file, saved, 'utf8');
    const savedSha = sha256Hex(saved);
    return { ...base, ...applied, undo: { ...applied.undo, expectedPostSha256: savedSha }, status: 'saved', savedTextSha256: savedSha };
  }

  log(level: 'info' | 'warn' | 'error', message: string): void {
    this.logs.push(`${level}: ${message}`);
  }
}
