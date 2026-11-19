import * as vscode from 'vscode';
import { createHash, randomUUID } from 'node:crypto';
import type { ApplyTextRequest, ApplyTextResult, EditProposal, ReviewDecision, TurnRef } from 'forge-harness';
import { createReader } from './editorPort';

export const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const refKey = (r: TurnRef) => JSON.stringify([r.sessionId, r.turnId]);
const key = (r: TurnRef & { callId: string; proposalId: string }) =>
  JSON.stringify([r.sessionId, r.turnId, r.callId, r.proposalId]);
type Choice = 'accept' | 'reject';
type Receipt = { doc: vscode.TextDocument; before: string; after: string; saveOnUndo: boolean; created?: boolean };
type Approval = { path: string; base: string | null; digest: string; ids: readonly string[] };

// Compose the preview while the user is reviewing. applyText uses the adapter's exact text.
export function preview(p: EditProposal, choices?: Readonly<Record<string, Choice>>) {
  let cursor = 0, text = '';
  const ids = new Set<string>();
  for (const h of p.hunks) {
    if (ids.has(h.hunkId) || !Number.isSafeInteger(h.startOffset) || !Number.isSafeInteger(h.endOffset) ||
        h.startOffset < cursor || h.endOffset < h.startOffset || h.endOffset > p.originalText.length ||
        p.originalText.slice(h.startOffset, h.endOffset) !== h.oldText) throw new Error('Invalid hunk');
    ids.add(h.hunkId);
    text += p.originalText.slice(cursor, h.startOffset) +
      (!choices || choices[h.hunkId] === 'accept' ? h.newText : h.oldText);
    cursor = h.endOffset;
  }
  return text + p.originalText.slice(cursor);
}

export class EditReview implements vscode.Disposable {
  private readonly approvals = new Map<string, Approval>();
  private readonly receipts = new Map<string, Receipt>();
  private readonly results = new Map<string, { fingerprint: string; result: ApplyTextResult }>();
  private readonly busy = new Set<string>();
  private active?: string;
  readonly readText: ReturnType<typeof createReader>;
  constructor(private readonly folder: vscode.WorkspaceFolder,
    private readonly save = (doc: vscode.TextDocument) => doc.save()) { this.readText = createReader(folder); }

  begin(ref: TurnRef) { this.end(); this.active = refKey(ref); }
  end() { this.active = undefined; this.approvals.clear(); }
  dispose() { this.end(); this.receipts.clear(); this.results.clear(); }
  isActive(ref: TurnRef) { return this.active === refKey(ref); }

  decide(p: EditProposal, choices: Record<string, Choice>): ReviewDecision {
    if (!this.isActive(p) || !p.hunks.length || preview(p) !== p.proposedText ||
        (p.isNewFile ? p.originalText !== '' : hash(p.originalText) !== p.baseSha256) ||
        Object.keys(choices).length !== p.hunks.length ||
        !p.hunks.every(h => Object.hasOwn(choices, h.hunkId) && ['accept','reject'].includes(choices[h.hunkId]))) {
      throw new Error('Review is incomplete or no longer current');
    }
    const ids = p.hunks.filter(h => choices[h.hunkId] === 'accept').map(h => h.hunkId);
    this.approvals.delete(key(p));
    if (ids.length) this.approvals.set(key(p), { path: p.path, base: p.baseSha256,
      digest: hash(preview(p, choices)), ids });
    return { kind: 'edit', sessionId: p.sessionId, turnId: p.turnId, callId: p.callId,
      proposalId: p.proposalId, hunks: { ...choices } };
  }

  async applyText(r: ApplyTextRequest): Promise<ApplyTextResult> {
    const id = key(r);
    const base = { sessionId: r.sessionId, turnId: r.turnId, callId: r.callId, proposalId: r.proposalId, path: r.path };
    const denied = { ...base, status: 'approval_missing' } as const;
    const digest = hash(r.text);
    const fp = JSON.stringify([r.path, r.expectedSha256, digest, r.textSha256, r.acceptedHunkIds]);
    const cached = this.results.get(id);
    if (cached) return cached.fingerprint === fp ? cached.result : denied;
    const a = this.approvals.get(id);
    if (!a || !this.isActive(r) || !vscode.workspace.isTrusted || a.path !== r.path ||
        a.base !== r.expectedSha256 || a.digest !== digest || r.textSha256 !== digest ||
        a.ids.length !== r.acceptedHunkIds.length || !a.ids.every(v => r.acceptedHunkIds.includes(v))) return denied;
    const uri = vscode.Uri.joinPath(this.folder.uri, r.path);
    const lock = uri.toString();
    if (this.busy.has(lock)) return { ...base, status: 'failed_before_apply', message: 'Document is busy' };
    this.busy.add(lock);
    let submitted = false;
    try {
      const snapshot = await this.readText(r.path);
      const observed = snapshot?.sha256 ?? null;
      if (observed !== a.base) return { ...base, status: 'stale', expectedSha256: a.base, observedSha256: observed };
      if (!snapshot) return await this.create(r, a, id, fp, base, digest, () => { submitted = true; });
      const doc = await vscode.workspace.openTextDocument(uri);
      const before = doc.getText(), current = hash(before), dirty = doc.isDirty;
      if (current !== a.base) return { ...base, status: 'stale', expectedSha256: a.base, observedSha256: current };
      if (a !== this.approvals.get(id) || !this.isActive(r) || !vscode.workspace.isTrusted) return denied;
      this.approvals.delete(id);
      const edit = new vscode.WorkspaceEdit();
      edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(before.length)), r.text);
      submitted = true;
      if (!await vscode.workspace.applyEdit(edit)) return { ...base, status: 'failed_before_apply', message: 'VS Code declined the text edit' };
      const undoId = randomUUID();
      const receipt = { doc, before, after: digest, saveOnUndo: false };
      this.receipts.set(undoId, receipt);
      const details = () => ({ ...base, appliedHunkIds: [...a.ids], undo: { undoId, path: r.path, expectedPostSha256: receipt.after } });
      let result: ApplyTextResult;
      if (dirty || hash(doc.getText()) !== digest || !this.isActive(r)) {
        result = { ...details(), status: 'buffer_applied', save: 'deferred', reason: 'Inspect the live buffer before saving' };
      } else {
        let saved = false;
        try { saved = await this.save(doc); } catch { /* Preserve the applied buffer and receipt. */ }
        if (saved && !doc.isDirty) {
          receipt.after = hash(doc.getText());
          receipt.saveOnUndo = true;
          result = { ...details(), status: 'saved', savedTextSha256: receipt.after };
        } else {
          result = { ...details(), status: 'save_failed', message: 'Inspect the document and retry Save',
            currentBufferSha256: hash(doc.getText()), disk: 'unknown', recovery: 'inspect_buffer_then_retry_save' };
        }
      }
      this.results.set(id, { fingerprint: fp, result });
      return result;
    } catch (error) {
      if (submitted) throw error;
      return { ...base, status: 'failed_before_apply', message: 'Could not safely open the target' };
    } finally { this.busy.delete(lock); }
  }

  // New file: created only if still absent (no overwrite), then opened and saved. Undo deletes it.
  private async create(r: ApplyTextRequest, a: Approval, id: string, fp: string,
    base: { sessionId: string; turnId: string; callId: string; proposalId: string; path: string },
    digest: string, markSubmitted: () => void): Promise<ApplyTextResult> {
    const denied = { ...base, status: 'approval_missing' } as const;
    if (a.base !== null || r.expectedSha256 !== null) return denied;
    if (a !== this.approvals.get(id) || !this.isActive(r) || !vscode.workspace.isTrusted) return denied;
    const uri = vscode.Uri.joinPath(this.folder.uri, r.path);
    this.approvals.delete(id);
    const edit = new vscode.WorkspaceEdit();
    edit.createFile(uri, { overwrite: false, ignoreIfExists: false, contents: Buffer.from(r.text, 'utf8') });
    markSubmitted();
    if (!await vscode.workspace.applyEdit(edit)) {
      return { ...base, status: 'failed_before_apply', message: 'VS Code declined to create the file (it may exist now)' };
    }
    const doc = await vscode.workspace.openTextDocument(uri);
    const undoId = randomUUID();
    const after = hash(doc.getText());
    const receipt: Receipt = { doc, before: '', after, saveOnUndo: false, created: true };
    this.receipts.set(undoId, receipt);
    const details = { ...base, appliedHunkIds: [...a.ids], undo: { undoId, path: r.path, expectedPostSha256: after } };
    let result: ApplyTextResult;
    if (after !== digest) {
      result = { ...details, status: 'buffer_applied', save: 'deferred', reason: 'Created file differs from the reviewed text' };
    } else if (doc.isDirty) {
      let saved = false;
      try { saved = await this.save(doc); } catch { /* keep the created file and receipt */ }
      result = saved && !doc.isDirty
        ? { ...details, status: 'saved', savedTextSha256: (receipt.after = hash(doc.getText())) }
        : { ...details, status: 'save_failed', message: 'Inspect the new file and retry Save', currentBufferSha256: hash(doc.getText()),
            disk: 'unknown', recovery: 'inspect_buffer_then_retry_save' };
    } else {
      result = { ...details, status: 'saved', savedTextSha256: after };
    }
    this.results.set(id, { fingerprint: fp, result });
    return result;
  }

  latestUndoId() { return Array.from(this.receipts.keys()).pop(); }
  async undo(id: string) {
    const r = this.receipts.get(id);
    if (!r || !vscode.workspace.isTrusted) throw new Error('Undo unavailable');
    const doc = await vscode.workspace.openTextDocument(r.doc.uri);
    const lock = doc.uri.toString();
    if (this.busy.has(lock) || hash(doc.getText()) !== r.after) throw new Error('Document changed; inspect before undo');
    this.busy.add(lock);
    try {
      if (r.created) {
        // Not via WorkspaceEdit.deleteFile: that moves to the trash, which WSL mounts do not support.
        if (doc.isDirty) throw new Error('The created file has unsaved changes; inspect before undo');
        await vscode.workspace.fs.delete(doc.uri, { useTrash: false });
        this.receipts.delete(id);
        return;
      }
      const edit = new vscode.WorkspaceEdit();
      edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), r.before);
      if (!await vscode.workspace.applyEdit(edit)) throw new Error('VS Code declined undo');
      this.receipts.delete(id);
      if (r.saveOnUndo && (hash(doc.getText()) !== hash(r.before) || !await this.save(doc))) {
        throw new Error('Undo applied to buffer; inspect before saving');
      }
    } finally { this.busy.delete(lock); }
  }
}
