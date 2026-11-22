import * as vscode from 'vscode';

/** When a setting takes effect: per-turn settings are read when a turn is sent; the rest when Forge (re)connects. */
const PER_TURN = new Set(['autoApproveSafeCommands', 'commandBudget.agent', 'commandBudget.inline', 'testCommandBudget.agent',
  'testCommandBudget.inline', 'context.semanticSearch']);

export interface SettingRow { key: string; value: string; source: string; applies: string }

/** Every forge.* setting with its effective value, where that value comes from and when a change applies. */
export function effectiveSettings(cfg: vscode.WorkspaceConfiguration, keys: readonly string[]): SettingRow[] {
  return keys.map((key) => {
    const i = cfg.inspect(key);
    const source = i?.workspaceFolderValue !== undefined ? 'folder' : i?.workspaceValue !== undefined ? 'workspace'
      : i?.globalValue !== undefined ? 'user' : 'default';
    return { key: 'forge.' + key, value: JSON.stringify(cfg.get(key)), source,
      applies: PER_TURN.has(key) ? 'next turn' : 'after reconnect (reload the window)' };
  });
}

/** The forge.* keys this extension contributes. */
export function forgeSettingKeys(): string[] {
  const ext = vscode.extensions.all.find((e) => e.packageJSON?.name === 'forgeathon-editor');
  const conf = ext?.packageJSON?.contributes?.configuration;
  const props = (Array.isArray(conf) ? conf[0] : conf)?.properties ?? {};
  return Object.keys(props).filter((k) => k.startsWith('forge.')).map((k) => k.slice('forge.'.length));
}

/** Quick pick of the effective settings; choosing one opens the Settings editor on it. */
export async function showEffectiveSettings(): Promise<void> {
  const rows = effectiveSettings(vscode.workspace.getConfiguration('forge'), forgeSettingKeys());
  const pick = await vscode.window.showQuickPick(rows.map((r) => ({ label: r.key + ' = ' + r.value, description: r.source,
    detail: 'Applies: ' + r.applies, key: r.key })), { title: 'Forge: effective settings', placeHolder: 'Choose one to open it in Settings' });
  if (pick) await vscode.commands.executeCommand('workbench.action.openSettings', '@id:' + pick.key);
}
