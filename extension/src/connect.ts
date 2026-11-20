import * as vscode from 'vscode';

export async function configuredHarness() {
  const cfg = vscode.workspace.getConfiguration('forge');
  const url = new URL(cfg.get('trueforgeUrl', 'http://127.0.0.1:8790'));
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash) throw new Error('Use a local TrueForge HTTP URL.');
  const { createHarness, PROTOCOL_VERSION } = await import('forge-harness');
  if (String(PROTOCOL_VERSION) !== '0.4.5') throw new Error('Forge editor requires harness protocol 0.4.5.');
  return { version: PROTOCOL_VERSION, harness: createHarness({
    trueforgeUrl: url.toString().replace(/\/$/, ''),
    mcpPort: cfg.get('mcpPort', 47615),
    contextBudgetTokens: cfg.get('context.budgetTokens', 8000)
  }) };
}
