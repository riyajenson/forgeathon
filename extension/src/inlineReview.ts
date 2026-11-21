import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import type { EditProposal, ReviewDecision } from 'forge-harness';
import { EditReview, preview } from './review';
import { hunkWarning, proposalWarnings } from './destructive';

export class InlineReview implements vscode.Disposable {
  private readonly texts = new Map<string, string>();
  private readonly registration = vscode.workspace.registerTextDocumentContentProvider('forge-preview', {
    provideTextDocumentContent: uri => this.texts.get(uri.toString()) ?? ''
  });
  private pending?: { proposal: EditProposal; resolve: (value: ReviewDecision | undefined) => void };
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  private picker?: vscode.QuickPick<vscode.QuickPickItem & { hunkId: string }>;
  /** Accept All / Reject All / Choose Hunks next to the diff. A quick pick, not a notification: it can be
   * closed when the review ends, so a cancelled or decided review never leaves an actionable prompt behind. */
  private actions?: vscode.QuickPick<vscode.QuickPickItem>;
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
      return await new Promise(resolve => { this.pending = {proposal: p, resolve}; this.prompt(p); });
    } finally {
      this.status.hide();
      this.actions?.hide();
      this.texts.delete(left.toString()); this.texts.delete(right.toString());
    }
  }

  // Non-modal prompt next to the diff; Escape hides it and keeps the review open (status bar item or commands).
  private prompt(p: EditProposal) {
    const n = p.hunks.length;
    const qp = vscode.window.createQuickPick();
    this.actions = qp;
    const warnings = proposalWarnings(p);
    qp.title = `Review ${n} hunk${n === 1 ? '' : 's'} in ${p.path}` + (warnings.length ? ` — ⚠ ${warnings.join('; ')}` : '');
    qp.placeholder = (warnings.length ? '⚠ This change deletes whole definitions; check them in the diff or choose hunks. ' : '') +
      'The proposed change is in the diff editor. Escape hides this; "Review hunks" in the status bar reopens the hunk list.';
    qp.ignoreFocusOut = true;
    qp.items = [{label: 'Accept All'}, {label: 'Reject All'}, {label: 'Choose Hunks...'}];
    qp.onDidAccept(() => {
      const pick = qp.selectedItems[0]?.label;
      qp.hide();
      if (this.pending?.proposal !== p) return;
      if (pick === 'Choose Hunks...') this.choose();
      else if (pick === 'Accept All') this.decideAll('accept');
      else if (pick === 'Reject All') this.decideAll('reject');
    });
    qp.onDidHide(() => { if (this.actions === qp) this.actions = undefined; qp.dispose(); });
    qp.show();
  }

  /** Any review control is still on screen (pending decision, action prompt or hunk list). */
  get open(): boolean { return !!(this.pending || this.actions || this.picker); }

  decideAll(choice: 'accept' | 'reject') {
    const pending = this.pending;
    if (!pending || !this.edits.isActive(pending.proposal)) return;
    const p = pending.proposal;
    const decision = this.edits.decide(p, Object.fromEntries(p.hunks.map(h => [h.hunkId, choice])));
    this.pending = undefined;
    this.picker?.hide(); this.actions?.hide();
    pending.resolve(decision);
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
      label: (hunkWarning(h) ? '$(warning) ' : '') + 'Hunk ' + (i + 1) + ' - line ' + p.originalText.slice(0, h.startOffset).split('\n').length,
      ...(hunkWarning(h) ? {description: hunkWarning(h)} : {}),
      detail: h.oldText.slice(0, 80) + ' | ' + h.newText.slice(0, 80), hunkId: h.hunkId
    }));
    picker.selectedItems = picker.items; // start from "accept all"; uncheck hunks to reject them
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
  // A cancelled review leaves nothing that looks actionable: its diff tab closes and the status bar says so.
  cancel() {
    const wasPending = !!this.pending;
    this.pending?.resolve(undefined); this.pending = undefined; this.picker?.hide(); this.actions?.hide(); this.status.hide();
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
