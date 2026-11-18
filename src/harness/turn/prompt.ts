import type { TurnRequest } from '../contract-types';
import type { EditorPort } from '../mcp/port';

/**
 * Builds the user message for a turn from the editor's prompt context.
 * The context engine (gather_context) adds retrieved code on top of this.
 */
export async function buildTurnInput(req: TurnRequest, port: EditorPort): Promise<string> {
  const parts: string[] = [req.instruction.trim()];
  if (req.selection) {
    const s = req.selection;
    const snap = await port.readText(s.path);
    parts.push(
      `Selected code: ${s.path} lines ${s.startLine}-${s.endLine}` + (snap ? ` (file sha256: ${snap.sha256})` : '') +
      `\n\`\`\`\n${s.text}\n\`\`\``,
    );
  } else if (req.activeFile) {
    const snap = await port.readText(req.activeFile);
    parts.push(`Active file: ${req.activeFile}${snap ? ` (sha256: ${snap.sha256})` : ''}`);
  }
  if (req.references?.length) {
    parts.push(`Referenced by the user: ${req.references.map((r) => (r.kind === 'file' ? `@file:${r.path}` : `@symbol:${r.name}`)).join(', ')}`);
  }
  return parts.join('\n\n');
}
