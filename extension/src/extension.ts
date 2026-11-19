import * as vscode from 'vscode';
import { configuredHarness } from './connect';
import { Workbench } from './workbench';

let workbench: Workbench | undefined;
export function activate(context: vscode.ExtensionContext) {
  const register = (command: string, run: (ui: Workbench) => Promise<void> | void) =>
    vscode.commands.registerCommand('forgeathon.' + command, async () => {
      try {
        const folders = vscode.workspace.workspaceFolders;
        if (!vscode.workspace.isTrusted || folders?.length !== 1) throw new Error('Open one trusted workspace folder.');
        if (workbench && workbench.folder.uri.toString() !== folders[0].uri.toString()) {
          await workbench.shutdown(); workbench = undefined;
        }
        await run(workbench ??= new Workbench(folders[0], configuredHarness));
      } catch (error) {
        void vscode.window.showErrorMessage(error instanceof Error ? error.message : 'Editor operation failed');
      }
    });
  context.subscriptions.push(
    register('inlineEdit', ui => ui.inline()), register('openAgentPanel', ui => ui.showPanel()),
    register('reviewHunks', ui => ui.choose()), register('undo', ui => ui.undo()),
    register('acceptAllHunks', ui => ui.decideAll('accept')), register('rejectAllHunks', ui => ui.decideAll('reject')),
    register('stop', ui => ui.stop()), register('newConversation', ui => ui.newConversation())
  );
}
export async function deactivate() { await workbench?.shutdown(); workbench = undefined; }
