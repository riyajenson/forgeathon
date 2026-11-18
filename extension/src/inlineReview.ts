import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import type { EditProposal, ReviewDecision } from 'forge-harness';
import { EditReview, preview } from './review';

export class InlineReview implements vscode.Disposable {
  private readonly texts = new Map<string, string>();
  private readonly registration = vscode.workspace.registerTextDocumentContentProvider('forge-preview', {
    provideTextDocumentContent: uri => this.texts.get(uri.toString()) ?? ''
  });
  private pending?: { proposal: EditProposal; resolve: (value: ReviewDecision | undefined) => void };
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  private picker?: vscode.QuickPick<vscode.QuickPickItem & { hunkId: string }>;
  constructor(private edits: EditReview) {
    this.status.text = '$(diff) Review hunks';
    this.status.command = 'forgeathon.reviewHunks';
  }

  async request(p: EditProposal): Promise<ReviewDecision | undefined> {
    if (this.pending || !this.edits.isActive(p)) throw new Error('Unexpected edit review');
    if (preview(p) !== p.proposedText) throw new Error('Diff does not match hunks');
    const revision = randomUUID();
    const left = vscode.Uri.from({scheme: 'forge-preview', path: '/' + p.path, query: revision + '-original'});
    const right = left.with({query: revision + '-proposed'});
    this.texts.set(left.toString(), p.originalText);
    this.texts.set(right.toString(), p.proposedText);
    try {
      await vscode.commands.executeCommand('vscode.diff', left, right, p.path + ' - proposed changes');
      if (!this.edits.isActive(p)) return undefined;
      this.status.show();
      return await new Promise(resolve => { this.pending = {proposal: p, resolve}; });
    } finally {
      this.status.hide();
      this.texts.delete(left.toString()); this.texts.delete(right.toString());
    }
  }

  choose() {
    const pending = this.pending;
    if (!pending || this.picker) return;
    const p = pending.proposal;
    const picker = vscode.window.createQuickPick<vscode.QuickPickItem & {hunkId: string}>();
    this.picker = picker;
    picker.title = 'Select hunks to accept. Enter submits; unchecked hunks are rejected';
    picker.canSelectMany = true;
    picker.items = p.hunks.map((h, i) => ({
      label: 'Hunk ' + (i + 1) + ' - line ' + p.originalText.slice(0, h.startOffset).split('\n').length,
      detail: h.oldText.slice(0, 80) + ' | ' + h.newText.slice(0, 80), hunkId: h.hunkId
    }));
    picker.onDidAccept(() => {
      const selected = new Set(picker.selectedItems.map(i => i.hunkId));
      if (this.pending === pending && this.edits.isActive(p)) {
        const decision = this.edits.decide(p, Object.fromEntries(p.hunks.map(h =>
          [h.hunkId, selected.has(h.hunkId) ? 'accept' : 'reject'])));
        this.pending = undefined;
        pending.resolve(decision);
      }
      picker.hide();
    });
    picker.onDidHide(() => { this.picker = undefined; picker.dispose(); });
    picker.show();
  }
  cancel() { this.pending?.resolve(undefined); this.pending = undefined; this.picker?.hide(); this.status.hide(); }
  dispose() { this.cancel(); this.texts.clear(); this.registration.dispose(); this.status.dispose(); }
}
