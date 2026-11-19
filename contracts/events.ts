import type { ContextReport } from './context';
import type { ApplyTextResult, EditProposal } from './edits';
import type { CallId, ProtocolError, TurnRef, Version } from './protocol';
import type { ToolId } from './tools';

type EventBody =
  | { t: 'session'; agentName: string; model: string; traceUrl: string; runtimeSessionId: string }
  | { t: 'turn_started' }
  | { t: 'status'; state: 'starting' | 'running' | 'awaiting_review' | 'retrying' | 'fallback' | 'compacting' | 'cancelling'; detail?: string }
  | { t: 'text'; messageId: string; delta: string }
  | { t: 'tool_call'; callId: CallId; tool: ToolId | 'internal'; displayName: string; summary: string; requiresApproval: boolean }
  | { t: 'tool_result'; callId: CallId; ok: boolean; summary: string }
  | { t: 'context_report'; report: ContextReport }
  | { t: 'review_request'; proposal: EditProposal }
  // autoApproved (0.4.3): already allowed by the adapter (TurnRequest.autoApproveSafeCommands); show it, do not prompt.
  | { t: 'command_request'; callId: CallId; command: string; cwd: string; unrestricted?: boolean; warning?: string; autoApproved?: boolean }
  // 0.4.4: the turn's command budget (TurnRequest.commandBudget) is used up; the command was refused to the model, not run.
  | { t: 'command_budget_reached'; callId: CallId; command: string; budget: number }
  | { t: 'edit_applied'; result: ApplyTextResult }
  | { t: 'fallback'; fromModel: string; toModel: string; reason: string }
  | { t: 'error'; error: ProtocolError }
  | { t: 'done'; status: 'done' | 'cancelled' | 'error'; summary?: string; usage?: { inputTokens: number; outputTokens: number } };
export type HarnessEvent = TurnRef & { version: Version; sequence: number } & EventBody;
