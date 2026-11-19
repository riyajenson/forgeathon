// Deferred tools (loaded on demand through TrueForge's call_tool): find_symbol and list_files.
import { buildIndex } from '../context/workspace-index';
import { normalizeWorkspacePath } from './paths';
import { listOptions } from './port';
import type { ToolContext, ToolOutcome } from './tools';

export interface FindSymbolArgs {
  name: string;
  limit?: number | undefined;
}

export async function findSymbolTool(ctx: ToolContext, args: FindSymbolArgs): Promise<ToolOutcome> {
  const name = typeof args.name === 'string' ? args.name.trim() : '';
  if (!name) return { ok: false, code: 'INVALID_ARGS', message: 'name must be a non-empty string' };
  const limit = Math.min(Math.max(1, Math.floor(args.limit ?? 20)), 100);
  const index = await buildIndex(ctx.port);
  const last = name.split('.').pop()!;
  let hits = (index.symbols.get(last) ?? []).filter((c) => !name.includes('.') || c.qualname === name || (c.qualname ?? '').endsWith(`.${name}`));
  let note = '';
  if (!hits.length) {
    const needle = last.toLowerCase();
    hits = [...index.symbols.entries()].filter(([k]) => k.toLowerCase().includes(needle)).flatMap(([, v]) => v);
    note = hits.length ? ` (no exact match; names containing "${last}")` : '';
  }
  if (!hits.length) return { ok: true, text: `No Python definition named "${name}" in the workspace index. Try search_workspace.` };
  const lines = hits.slice(0, limit).map((c) => `${c.path}:${c.startLine}-${c.endLine}  ${c.kind} ${c.qualname ?? c.name}: ${c.signature ?? ''}`.trimEnd());
  return { ok: true, text: `${hits.length} definition(s) of "${name}"${note}:\n${lines.join('\n')}${hits.length > limit ? `\n[${hits.length - limit} more]` : ''}` };
}

export interface ListFilesArgs {
  prefix?: string | undefined;
  limit?: number | undefined;
}

export async function listFilesTool(ctx: ToolContext, args: ListFilesArgs): Promise<ToolOutcome> {
  let prefix: string | undefined;
  if (args.prefix !== undefined && args.prefix !== '' && args.prefix !== '.') {
    const p = normalizeWorkspacePath(args.prefix);
    if (!p) return { ok: false, code: 'OUTSIDE_WORKSPACE', message: `prefix must be workspace-relative: ${args.prefix}` };
    prefix = p;
  }
  const limit = Math.min(Math.max(1, Math.floor(args.limit ?? 200)), 1000);
  const files = await ctx.port.listFiles(listOptions(prefix, limit + 1));
  const shown = files.slice(0, limit);
  return { ok: true, text: `${shown.length}${files.length > limit ? '+' : ''} file(s)${prefix ? ` under ${prefix}` : ''}:\n${shown.join('\n')}` };
}
