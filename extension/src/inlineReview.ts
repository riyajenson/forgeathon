import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import type { EditProposal, ReviewDecision } from 'forge-harness';
import { EditReview, preview } from './review';
import { hunkWarning, proposalWarnings } from './destructive';

const acceptAllButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('check'), tooltip: 'Accept all hunks' };
const rejectAllButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('close'), tooltip: 'Reject all hunks' };

export class InlineReview implements vscode.Disposable {
  private readonly texts = new Map<string, string>();
  private readonly contentChanged = new vscode.EventEmitter<vscode.Uri>();
  private readonly closeDocuments = vscode.workspace.onDidCloseTextDocument(document => {
    if (document.uri.scheme === 'forge-preview') this.texts.delete(document.uri.toString());
  });
  private readonly registration = vscode.workspace.registerTextDocumentContentProvider('forge-preview', {
    onDidChange: this.contentChanged.event,
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
    let diffOpened = false;
    try {
      await vscode.commands.executeCommand('vscode.diff', left, right, p.path + ' - proposed changes');
      diffOpened = true;
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
      if (!diffOpened) { this.texts.delete(left.toString()); this.texts.delete(right.toString()); }
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

  /** Keep the proposed side of the editor diff equal to the currently checked hunks. */
  private showChoicePreview(p: EditProposal, accepted: ReadonlySet<string>) {
    const uri = this.diff;
    if (!uri) return;
    const key = uri.toString();
    if (!this.texts.has(key)) return;
    const choices = Object.fromEntries(p.hunks.map(h => [h.hunkId, accepted.has(h.hunkId) ? 'accept' : 'reject'])) as
      Record<string, 'accept' | 'reject'>;
    const next = preview(p, choices);
    if (this.texts.get(key) === next) return;
    this.texts.set(key, next);
    this.contentChanged.fire(uri);
  }

  decideAll(choice: 'accept' | 'reject') {
    const pending = this.pending;
    if (!pending) return;
    if (!this.edits.isActive(pending.proposal)) { this.finish(pending, undefined); return; }
    try {
      const p = pending.proposal;
      const decision = this.edits.decide(p, Object.fromEntries(p.hunks.map(h => [h.hunkId, choice])));
      this.showChoicePreview(p, new Set(choice === 'accept' ? p.hunks.map(h => h.hunkId) : []));
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
    const warnings = proposalWarnings(p);
    picker.title = 'Select hunks to accept. The diff updates as you check them; Enter submits.' + (warnings.length ? ` ⚠ ${warnings.join('; ')}` : '');
    picker.placeholder = (warnings.length ? '⚠ This change deletes whole definitions; check them in the diff. ' : '') +
      `Review ${p.hunks.length} hunks in ${p.path}. Escape hides this; "Review hunks" in the status bar reopens it.`;
    picker.ignoreFocusOut = true;
    picker.canSelectMany = true;
    picker.buttons = [acceptAllButton, rejectAllButton];
    picker.items = p.hunks.map((h, i) => ({
      label: (hunkWarning(h) ? '$(warning) ' : '') + 'Hunk ' + (i + 1) + ' - line ' + p.originalText.slice(0, h.startOffset).split('\n').length,
      ...(hunkWarning(h) ? {description: hunkWarning(h)} : {}),
      detail: h.oldText.slice(0, 80) + ' | ' + h.newText.slice(0, 80), hunkId: h.hunkId
    }));
    picker.selectedItems = picker.items; // start from "accept all"; uncheck hunks to reject them
    picker.onDidTriggerButton(button => {
      if (button === acceptAllButton) this.decideAll('accept');
      else if (button === rejectAllButton) this.decideAll('reject');
    });
    picker.onDidChangeSelection(items => {
      if (this.pending !== pending || !this.edits.isActive(p)) return;
      this.showChoicePreview(p, new Set(items.map(i => i.hunkId)));
    });
    picker.onDidAccept(() => {
      if (this.pending !== pending) { picker.hide(); return; }
      if (!this.edits.isActive(p)) { this.finish(pending, undefined); return; }
      const selected = new Set(picker.selectedItems.map(i => i.hunkId));
      try {
        const decision = this.edits.decide(p, Object.fromEntries(p.hunks.map(h =>
          [h.hunkId, selected.has(h.hunkId) ? 'accept' : 'reject'])));
        this.showChoicePreview(p, selected);
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
  dispose() {
    this.cancel(); this.texts.clear(); this.registration.dispose(); this.closeDocuments.dispose();
    this.contentChanged.dispose(); this.status.dispose();
  }
}
