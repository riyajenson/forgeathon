import * as vscode from 'vscode';

export type Attachment = { kind: 'file' | 'symbol'; value: string };

/** Mentions for the request box; paths with whitespace cannot be written as @file: mentions and are left out. */
export function mentionsFor(items: readonly Attachment[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const i of items) {
    if (/\s/.test(i.value)) continue;
    const m = (i.kind === 'file' ? '@file:' : '@symbol:') + i.value;
    if (!seen.has(m)) { seen.add(m); out.push(m); }
  }
  return out.length ? out.join(' ') + ' ' : '';
}

const EXCLUDE = '{**/node_modules/**,**/.git/**,**/.venv/**,**/venv/**,**/__pycache__/**,**/*.pyc,**/dist/**,**/build/**}';
type Item = vscode.QuickPickItem & { attach: Attachment };

/**
 * A multi-select picker of workspace files; typing an identifier also offers it as @symbol:. Selections survive filtering.
 * Resolves to the mentions to insert, or '' when cancelled. Pinned context still goes through the harness read policy.
 */
export async function pickAttachments(folder: vscode.WorkspaceFolder): Promise<string> {
  const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/*'), EXCLUDE, 5000);
  const files: Item[] = uris.map((u) => vscode.workspace.asRelativePath(u, false)).sort()
    .map((p) => ({ label: p, description: 'file', attach: { kind: 'file' as const, value: p } }));
  const picker = vscode.window.createQuickPick<Item>();
  picker.canSelectMany = true;
  picker.matchOnDescription = true;
  picker.title = 'Attach context: files (type a name to also offer @symbol:)';
  picker.placeholder = 'Filter files; select several, then press Enter';
  const chosen = new Map<string, Item>();
  const symbolItem = (name: string): Item => ({ label: '@symbol:' + name, description: 'symbol (resolved by the Forge index)', attach: { kind: 'symbol', value: name }, alwaysShow: true });
  const refresh = (value: string) => {
    const typed = /^[A-Za-z_][\w.]*$/.test(value) ? [symbolItem(value)] : [];
    const keep = [...chosen.values()].filter((c) => c.attach.kind === 'symbol' && c.attach.value !== value);
    picker.items = [...typed, ...keep, ...files];
    picker.selectedItems = picker.items.filter((i) => chosen.has(i.label));
  };
  picker.onDidChangeSelection((sel) => {
    for (const i of picker.items) if (!sel.includes(i)) chosen.delete(i.label);
    for (const i of sel) chosen.set(i.label, i);
  });
  picker.onDidChangeValue(refresh);
  refresh('');
  return new Promise<string>((resolve) => {
    let accepted = false;
    picker.onDidAccept(() => { accepted = true; picker.hide(); });
    picker.onDidHide(() => { picker.dispose(); resolve(accepted ? mentionsFor([...chosen.values()].map((c) => c.attach)) : ''); });
    picker.show();
  });
}
