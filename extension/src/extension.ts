import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('forgeathon.inlineEdit', async () => {
      await vscode.window.showInformationMessage(
        'Inline editing is not implemented yet. This scaffold does not send requests or change files.'
      );
    }),
    vscode.commands.registerCommand('forgeathon.openAgentPanel', async () => {
      await vscode.window.showInformationMessage(
        'The agent panel is not implemented yet. TrueForge integration awaits an agreed adapter contract.'
      );
    })
  );
}
