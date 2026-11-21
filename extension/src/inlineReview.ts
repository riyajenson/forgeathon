import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import type { EditProposal, ReviewDecision } from 'forge-harness';
import { EditReview, preview } from './review';

const acceptAllButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('check'), tooltip: 'Accept all hunks' };
const rejectAllButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('close'), tooltip: 'Reject all hunks' };

export class InlineReview implements vscode.Disposable {
  private readonly texts = new Map<string, string>();
  private readonly registration = vscode.workspace.registerTextDocumentContentProvider('forge-preview', {
    provideTextDocumentContent: uri => this.texts.get(uri.toString()) ?? ''
  });
  private pending?: { proposal: EditProposal; resolve: (value: ReviewDecision | undefined) => void; reject: (error: unknown) => void };
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
    this.diff = right;
    try {
      await vscode.commands.executeCommand('vscode.diff', left, right, p.path + ' - proposed changes');
      if (!this.edits.isActive(p)) return undefined;
      this.status.show();
      return await new Promise((resolve, reject) => {
        this.pending = {proposal: p, resolve, reject};
        this.choose();
      });
    } finally {
      this.status.hide();
      const picker = this.picker;
      this.picker = undefined;
      picker?.hide();
      this.texts.delete(left.toString()); this.texts.delete(right.toString());
    }
  }

  /** A hunk decision is still pending or its picker is visible. */
  get open(): boolean { return !!(this.pending || this.picker); }

  private finish(pending: NonNullable<InlineReview['pending']>, decision: ReviewDecision | undefined) {
    if (this.pending !== pending) return;
    this.pending = undefined;
    const picker = this.picker;
    this.picker = undefined;
    picker?.hide();
    pending.resolve(decision);
  }

  private fail(pending: NonNullable<InlineReview['pending']>, error: unknown) {
    if (this.pending !== pending) return;
    this.pending = undefined;
    const picker = this.picker;
    this.picker = undefined;
    picker?.hide();
    pending.reject(error);
  }

  decideAll(choice: 'accept' | 'reject') {
    const pending = this.pending;
    if (!pending) return;
    if (!this.edits.isActive(pending.proposal)) { this.finish(pending, undefined); return; }
    try {
      const p = pending.proposal;
      const decision = this.edits.decide(p, Object.fromEntries(p.hunks.map(h => [h.hunkId, choice])));
      this.finish(pending, decision);
    } catch (error) { this.fail(pending, error); }
  }

  choose() {
    const pending = this.pending;
    if (!pending || this.picker) return;
    const p = pending.proposal;
    if (!this.edits.isActive(p)) { this.finish(pending, undefined); return; }
    const picker = vscode.window.createQuickPick<vscode.QuickPickItem & {hunkId: string}>();
    this.picker = picker;
    picker.title = 'Select hunks to accept. Enter submits; unchecked hunks are rejected';
    picker.placeholder = `Review ${p.hunks.length} hunks in ${p.path}. Escape hides this; "Review hunks" in the status bar reopens it.`;
    picker.ignoreFocusOut = true;
    picker.canSelectMany = true;
    picker.buttons = [acceptAllButton, rejectAllButton];
    picker.items = p.hunks.map((h, i) => ({
      label: 'Hunk ' + (i + 1) + ' - line ' + p.originalText.slice(0, h.startOffset).split('\n').length,
      detail: h.oldText.slice(0, 80) + ' | ' + h.newText.slice(0, 80), hunkId: h.hunkId
    }));
    picker.selectedItems = picker.items; // start from "accept all"; uncheck hunks to reject them
    picker.onDidTriggerButton(button => {
      if (button === acceptAllButton) this.decideAll('accept');
      else if (button === rejectAllButton) this.decideAll('reject');
    });
    picker.onDidAccept(() => {
      if (this.pending !== pending) { picker.hide(); return; }
      if (!this.edits.isActive(p)) { this.finish(pending, undefined); return; }
      const selected = new Set(picker.selectedItems.map(i => i.hunkId));
      try {
        const decision = this.edits.decide(p, Object.fromEntries(p.hunks.map(h =>
          [h.hunkId, selected.has(h.hunkId) ? 'accept' : 'reject'])));
        this.finish(pending, decision);
      } catch (error) { this.fail(pending, error); }
    });
    picker.onDidHide(() => { if (this.picker === picker) this.picker = undefined; picker.dispose(); });
    picker.show();
  }
  // A cancelled review leaves nothing that looks actionable: its diff tab closes and the status bar says so.
  cancel() {
    const wasPending = !!this.pending;
    const pending = this.pending;
    this.pending = undefined;
    pending?.resolve(undefined);
    const picker = this.picker;
    this.picker = undefined;
    picker?.hide();
    this.status.hide();
    const diff = this.diff?.toString();
    this.diff = undefined;
    if (!diff || !wasPending) return;
    const tabs = vscode.window.tabGroups.all.flatMap(g => g.tabs).filter(t =>
      t.input instanceof vscode.TabInputTextDiff && t.input.modified.toString() === diff);
    if (tabs.length) void vscode.window.tabGroups.close(tabs);
    vscode.window.setStatusBarMessage('Forge: review cancelled; that change was not applied', 6000);
  }
  /** The proposed side of the review's diff tab, while it may still be open. */
  private diff?: vscode.Uri;
  dispose() { this.cancel(); this.texts.clear(); this.registration.dispose(); this.status.dispose(); }
}
