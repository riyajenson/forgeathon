import type { ToolId } from '../contract-types';
import { redactSecrets } from '../trueforge/errors';
import { normalizeEdits } from '../review';

/** MCP tool name → contract ToolId. Anything else (TrueForge system tools) is 'internal'. */
const TOOL_IDS: Record<string, ToolId> = {
  read_file: 'read',
  search_workspace: 'search',
  find_symbol: 'symbol',
  propose_edit: 'propose_edit',
  run_command: 'terminal',
  gather_context: 'context',
  list_files: 'list',
};

/** Tools that TrueForge gates with approval in our agents (requirements: propose_edit, run_command). */
export const APPROVAL_TOOLS = new Set(['propose_edit', 'run_command']);

export function toolIdOf(tool: string): ToolId | 'internal' {
  return TOOL_IDS[tool] ?? 'internal';
}

/** One-line, display-safe summary of a tool call's arguments. */
export function summarizeArgs(tool: string, args: unknown): string {
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  let s: string;
  switch (tool) {
    case 'read_file': {
      const range = a['start_line'] ? ` lines ${a['start_line']}-${a['end_line'] ?? 'end'}` : '';
      s = `${str(a['path'])}${range}`;
      break;
    }
    case 'search_workspace':
      s = `${a['regex'] ? 'regex ' : ''}"${str(a['query'])}"${a['path_prefix'] ? ` in ${str(a['path_prefix'])}` : ''}`;
      break;
    case 'propose_edit': {
      const edits = normalizeEdits(a['edits']);
      const n = Array.isArray(edits) ? edits.length : 0;
      s = `${str(a['path'])} (${n} edit${n === 1 ? '' : 's'})${a['summary'] ? `: ${str(a['summary'])}` : ''}`;
      break;
    }
    case 'run_command':
      s = str(a['command']);
      break;
    case 'gather_context':
      s = str(a['query']) || str(a['task']);
      break;
    case 'find_symbol':
      s = str(a['name']);
      break;
    case 'list_files':
      s = str(a['prefix']) || '(workspace)';
      break;
    case 'create_sub_agent':
      s = `${str(a['name'])}: ${str(a['input'])}`;
      break;
    default:
      s = '';
  }
  return redactSecrets(s.replace(/\s+/g, ' ').trim()).slice(0, 160);
}

/** First line of a tool result, capped, for display. */
export function summarizeResult(content: string): string {
  let text = content;
  try {
    const v = JSON.parse(content) as { error?: unknown };
    if (v && typeof v === 'object' && 'error' in v) {
      const e = v.error as { code?: string; message?: string } | Array<{ text?: string }>;
      if (Array.isArray(e)) text = e.map((p) => p.text ?? '').join(' ');
      else text = [e.code, e.message].filter(Boolean).join(': ');
    }
  } catch {
    // plain text result
  }
  return redactSecrets(text.split('\n').find((l) => l.trim() !== '')?.trim() ?? '').slice(0, 200);
}
