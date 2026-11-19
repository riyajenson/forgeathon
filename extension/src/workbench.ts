import * as vscode from 'vscode';
import type { EditorPort, ForgeHarness, HarnessEvent, PromptContext, Version } from 'forge-harness';
import { createFileLister, createStatusLogger } from './editorPort';
import { AgentPanel } from './agentPanel';
import { InlineReview } from './inlineReview';
import { EditReview } from './review';
import { TurnController } from './turn';

type Connection = { harness: ForgeHarness; version: Version };
export class Workbench implements vscode.Disposable {
  readonly edits: EditReview;
  private readonly review: InlineReview;
  private readonly logger = createStatusLogger();
  private readonly port: EditorPort;
  private pendingRun?: AbortController;
  private readonly panel = new AgentPanel({
    send: text => this.run('agent', text, this.activeContext()),
    stop: () => this.stop(), review: () => this.choose(),
    command: allow => this.commandAnswer?.(allow)
  });
  private controller?: TurnController;
  private harness?: ForgeHarness;
  private starting?: Promise<TurnController>;
  private closed = false;
  private commandPicker?: vscode.QuickPick<vscode.QuickPickItem>;
  private commandAnswer?: (allow: boolean) => void;

  constructor(readonly folder: vscode.WorkspaceFolder,
    private readonly factory?: () => Connection | Promise<Connection>) {
    this.edits = new EditReview(folder);
    this.review = new InlineReview(this.edits);
    this.port = { readText: this.edits.readText, listFiles: createFileLister(folder),
      applyText: request => this.edits.applyText(request), log: (level,msg) => this.logger.log(level,msg) };
  }

  private activeContext(): PromptContext {
    const doc = vscode.window.activeTextEditor?.document;
    return doc && vscode.workspace.getWorkspaceFolder(doc.uri)?.uri.toString() === this.folder.uri.toString()
      ? { activeFile: vscode.workspace.asRelativePath(doc.uri, false) } : {};
  }
  events(event: HarnessEvent) {
    this.panel.event(event);
    // Also notify outside the panel, which may be closed during an inline edit.
    if (event.t === 'fallback') {
      void vscode.window.showWarningMessage('Primary model failed: ' + event.reason + ' → switched to ' + event.toModel);
    } else if (event.t === 'error') {
      void vscode.window.showErrorMessage('Forge: ' + event.error.message);
    }
  }
  notice(text: string) { this.panel.notice(text); }
  showPanel() { this.panel.open(); }
  choose() { this.review.choose(); }
  decideAll(choice: 'accept' | 'reject') { this.review.decideAll(choice); }
  /** A review prompt, hunk list or pending decision is still showing. */
  reviewControlsOpen() { return this.review.open; }
  newConversation() { this.controller?.newConversation(); this.panel.notice('New conversation: the next request starts a new session.'); }
  async undo() {
    const id = this.edits.latestUndoId();
    if (id) await this.edits.undo(id); else this.notice('No reviewed edit to undo.');
  }
  async stop() {
    this.pendingRun?.abort();
    this.panel.notice('Stopping...');
    await this.controller?.stop();
  }
  private async command(command: string, cwd: string, warning?: string) {
    const picker = vscode.window.createQuickPick();
    this.commandPicker = picker;
    picker.title = (warning ? '⚠ Unrestricted command. ' : '') + 'Allow this command in ' + cwd + '?';
    picker.placeholder = warning || command;
    picker.items = [{label:'Deny'}, {label:'Allow once', detail:command, ...(warning ? {description: warning} : {})}];
    return new Promise<boolean>(resolve => {
      let allow = false;
      // The panel's Allow/Deny buttons and this quick pick answer the same single decision.
      this.commandAnswer = answer => { allow = answer; picker.hide(); };
      picker.onDidAccept(() => { allow = picker.selectedItems[0]?.label === 'Allow once'; picker.hide(); });
      picker.onDidHide(() => {
        this.commandPicker = undefined; this.commandAnswer = undefined; picker.dispose();
        this.panel.commandAnswered(); resolve(allow);
      });
      picker.show();
    });
  }

  private async connect() {
    if (!this.factory) throw new Error('TrueForge integration is awaiting the verified harness handoff.');
    const {harness, version} = await this.factory();
    this.harness = harness;
    try {
      await harness.start(this.port);
      if (this.closed) throw new Error('Workspace closed');
      return this.controller = new TurnController(harness, version, this.folder.uri.fsPath, this.edits, {
        event: e => this.events(e), review: p => this.review.request(p), command: e => this.command(e.command,e.cwd,e.unrestricted ? e.warning || 'Unrestricted command' : undefined),
        cancelReview: () => { this.review.cancel(); this.commandPicker?.hide(); }, notice: s => this.notice(s)
      });
    } catch (error) { await harness.dispose(); this.harness = undefined; throw error; }
  }

  async run(mode: 'inline' | 'agent', instruction: string, context: PromptContext) {
    if (!vscode.workspace.isTrusted || this.closed) throw new Error('A trusted workspace is required');
    if (this.pendingRun) throw new Error('A turn is already in progress');
    const run = this.pendingRun = new AbortController(); this.panel.start();
    try {
      const controller = this.controller ?? await (this.starting ??= this.connect().finally(() => { this.starting = undefined; }));
      if (run.signal.aborted) { this.panel.notice('Stopped before submitting'); return; }
      // Off by default. Only pytest / python -m pytest / git status / git diff without shell operators qualify
      // (decided by the harness); edits are always reviewed.
      const cfg = vscode.workspace.getConfiguration('forge');
      const autoApproveSafeCommands = cfg.get<unknown>('autoApproveSafeCommands', false) === true;
      // Hard per-turn limit on commands, enforced by the harness (default 3 agent, 1 inline).
      const budget = cfg.get<unknown>(`commandBudget.${mode}`);
      const commandBudget = typeof budget === 'number' && Number.isInteger(budget) && budget >= 0 ? budget : undefined;
      await controller.run(mode, instruction, context, {autoApproveSafeCommands, ...(commandBudget === undefined ? {} : {commandBudget})});
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Turn failed';
      this.panel.error(message); this.panel.notice('Failed'); throw error;
    } finally { this.pendingRun = undefined; this.panel.finish(); }
  }
  async inline() {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) throw new Error('Select the code to edit first.');
    const doc = editor.document, selection = editor.selection;
    if (vscode.workspace.getWorkspaceFolder(doc.uri)?.uri.toString() !== this.folder.uri.toString())
      throw new Error('Select a file in the active workspace.');
    const activeFile = vscode.workspace.asRelativePath(doc.uri, false).replace(/\\/g, '/');
    const context = {activeFile, selection:{ path: activeFile, text: doc.getText(selection),
      startLine: selection.start.line + 1, endLine: selection.end.line + (selection.end.character === 0 ? 0 : 1) }};
    const instruction = await vscode.window.showInputBox({prompt:'How should the selection change?'});
    if (!instruction?.trim()) return;
    // Visible progress for inline turns (the panel may be closed); Cancel stops the turn.
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Forge inline edit', cancellable: true },
      (progress, token) => {
        token.onCancellationRequested(() => { void this.stop(); });
        progress.report({ message: 'waiting for the model...' });
        return this.run('inline', instruction, context);
      });
  }

  dispose() {
    this.pendingRun?.abort(); this.closed = true; this.panel.dispose(); this.commandPicker?.hide(); this.review.dispose(); this.edits.dispose(); this.logger.dispose();
  }
  async shutdown() { this.dispose(); await this.harness?.dispose(); }
}
