import { assembleContext, type ContextAssemblyOptions, type ContextResult } from '../context';
import type { TurnRequest } from '../contract-types';
import type { EditorPort } from '../mcp/port';
import { normalizeWorkspacePath } from '../mcp/paths';
import { modelPathRefusal } from '../context/files';

export interface TurnInput {
  input: string;
  context: ContextResult | undefined;
}

/**
 * Builds the user message for a turn: the instruction, the editor's prompt context, and the context the
 * engine retrieved within the budget (pinned selection/@file/@symbol first, then ranked code).
 */
export async function buildTurnInput(req: TurnRequest, port: EditorPort, budgetTokens: number, signal?: AbortSignal, options: ContextAssemblyOptions = {}): Promise<TurnInput> {
  const parts: string[] = [req.instruction.trim()];
  const refused = (p: string) => modelPathRefusal(normalizeWorkspacePath(p) ?? p);
  const selectionRefusal = req.selection ? refused(req.selection.path) : null;
  if (req.selection) {
    const s = req.selection;
    if (selectionRefusal) parts.push(`Selected code: ${s.path} lines ${s.startLine}-${s.endLine} (not sent: ${selectionRefusal})`);
    else {
      const snap = await port.readText(s.path);
      parts.push(`Selected code: ${s.path} lines ${s.startLine}-${s.endLine}` + (snap ? ` (file sha256: ${snap.sha256})` : ''));
    }
  } else if (req.activeFile) {
    const snap = refused(req.activeFile) ? null : await port.readText(req.activeFile);
    parts.push(`Active file: ${req.activeFile}${snap ? ` (sha256: ${snap.sha256})` : ''}`);
  }
  let context: ContextResult | undefined;
  try {
    context = await assembleContext(port, {
      instruction: req.instruction,
      ...(req.selection ? { selection: req.selection } : {}),
      ...(req.activeFile ? { activeFile: req.activeFile } : {}),
      ...(req.references ? { references: req.references } : {}),
      budgetTokens: req.mode === 'inline' ? Math.min(budgetTokens, 2500) : budgetTokens,
      semanticSearch: req.semanticSearch === true,
      ...(signal ? { signal } : {}),
      mode: req.mode,
    }, undefined, options);
    parts.push(context.text);
  } catch (e) {
    port.log('warn', `context assembly failed: ${(e as Error).message}`);
    if (req.selection && !selectionRefusal) parts.push(`\`\`\`\n${req.selection.text}\n\`\`\``);
  }
  return { input: parts.join('\n\n'), context };
}
