// gather_context: lets the agent ask the context engine for a different focus during a turn.
import { assembleContext } from '../context';
import type { ToolContext, ToolOutcome } from './tools';

export interface GatherContextArgs {
  task: string;
  budget_tokens?: number | undefined;
  semantic_search?: boolean | undefined;
}

export const GATHER_DEFAULT_BUDGET = 6000;

export async function gatherContextTool(ctx: ToolContext, args: GatherContextArgs): Promise<ToolOutcome> {
  if (typeof args.task !== 'string' || !args.task.trim()) return { ok: false, code: 'INVALID_ARGS', message: 'task must be a non-empty string' };
  const budget = Math.min(Math.max(1000, Math.floor(args.budget_tokens ?? GATHER_DEFAULT_BUDGET)), 12000);
  const result = await assembleContext(ctx.port, { instruction: args.task, budgetTokens: budget, mode: 'agent', semanticSearch: args.semantic_search === true });
  ctx.scope?.onContext?.(result.report);
  const files = [...new Set(result.report.selections.map((s) => s.path))];
  return { ok: true, text: `Ranked files: ${files.join(', ') || 'none'}\n\n${result.text}` };
}
