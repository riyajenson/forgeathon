import * as vscode from 'vscode';
import type { EditorPort, ForgeHarness, HarnessEvent, PromptContext, Version } from 'forge-harness';
import { createFileLister, createStatusLogger } from './editorPort';
import { InlineReview } from './inlineReview';
import { EditReview } from './review';
import { TurnController } from './turn';

export class Workbench implements vscode.Disposable {
  readonly edits: EditReview;
  private readonly review: InlineReview;
  private readonly logger = createStatusLogger();
  private readonly port: EditorPort;
  private controller?: TurnController;
  private harness?: ForgeHarness;
  private starting?: Promise<TurnController>;
  private closed = false;
  private commandPicker?: vscode.QuickPick<vscode.QuickPickItem>;

  constructor(readonly folder: vscode.WorkspaceFolder,
    private readonly factory?: () => { harness: ForgeHarness; version: Version }) {
    this.edits = new EditReview(folder);
    this.review = new InlineReview(this.edits);
    this.port = { readText: this.edits.readText, listFiles: createFileLister(folder),
      applyText: request => this.edits.applyText(request), log: (level,msg) => this.logger.log(level,msg) };
  }

  events(_event: HarnessEvent) {}
  notice(text: string) { void vscode.window.showInformationMessage(text); }
  showPanel() { this.notice('The agent panel is unavailable in this build.'); }
  choose() { this.review.choose(); }
  async undo() {
    const id = this.edits.latestUndoId();
    if (id) await this.edits.undo(id); else this.notice('No reviewed edit to undo.');
  }
  async stop() { await this.controller?.stop(); }
  private async command(command: string, cwd: string) {
    const picker = vscode.window.createQuickPick();
    this.commandPicker = picker;
    picker.title = 'Allow this command in ' + cwd + '?';
    picker.placeholder = command;
    picker.items = [{label:'Deny'}, {label:'Allow once', detail:command}];
    return new Promise<boolean>(resolve => {
      let allow = false;
      picker.onDidAccept(() => { allow = picker.selectedItems[0]?.label === 'Allow once'; picker.hide(); });
      picker.onDidHide(() => { this.commandPicker = undefined; picker.dispose(); resolve(allow); });
      picker.show();
    });
  }

  private async connect() {
    if (!this.factory) throw new Error('TrueForge integration is awaiting the verified harness handoff.');
    const {harness, version} = this.factory();
    this.harness = harness;
    try {
      await harness.start(this.port);
      if (this.closed) throw new Error('Workspace closed');
      return this.controller = new TurnController(harness, version, this.folder.uri.fsPath, this.edits, {
        event: e => this.events(e), review: p => this.review.request(p), command: e => this.command(e.command,e.cwd),
        cancelReview: () => { this.review.cancel(); this.commandPicker?.hide(); }, notice: s => this.notice(s)
      });
    } catch (error) { await harness.dispose(); this.harness = undefined; throw error; }
  }

  async run(mode: 'inline' | 'agent', instruction: string, context: PromptContext) {
    if (!vscode.workspace.isTrusted || this.closed) throw new Error('A trusted workspace is required');
    const controller = this.controller ?? await (this.starting ??= this.connect().finally(() => { this.starting = undefined; }));
    return controller.run(mode, instruction, context);
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
    if (instruction?.trim()) await this.run('inline', instruction, context);
  }

  dispose() {
    this.closed = true; this.commandPicker?.hide(); this.review.dispose(); this.edits.dispose(); this.logger.dispose();
  }
  async shutdown() { this.dispose(); await this.harness?.dispose(); }
}
