import type { CallRef, ProtocolError } from './protocol';
import type { ContextReport, SymbolLocation } from './context';
import type { ApplyResult, EditProposal } from './edits';

type Operations = {
  context: [{ query: string; budgetTokens: number }, { report: ContextReport }];
  list: [{ prefix?: string; limit: number }, { paths: readonly string[] }];
  read: [{ path: string }, { text: string; sha256: string }];
  search: [{ query: string; limit: number }, { matches: readonly { path: string; line: number; excerpt: string }[] }];
  symbol: [{ name: string; limit: number }, { matches: readonly SymbolLocation[] }];
  propose_edit: [EditProposal, { result: ApplyResult }];
  terminal: [{ command: string; cwd: string }, { stdout: string; stderr: string; exitCode: number | null }];
};
export type ToolId = keyof Operations;
export type ReadOnlyTool = 'context' | 'list' | 'read' | 'search' | 'symbol';
export type ToolRequest = { [K in ToolId]: CallRef & {
  tool: K; args: Operations[K][0];
  approval: K extends ReadOnlyTool ? 'none' : K extends 'terminal' ? 'command' : 'hunks';
} }[ToolId];
export type ToolResponse = { [K in ToolId]: CallRef & { tool: K } & (
  | { ok: true; result: Operations[K][1] } | { ok: false; error: ProtocolError }
) }[ToolId];
