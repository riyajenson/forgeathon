import type { PromptContext } from './context';
import type { EditorBridge, ReviewDecision } from './edits';
import type { HarnessEvent } from './events';
import type { Request, Response, SessionId, TurnRef } from './protocol';

export type TurnRequest = TurnRef & PromptContext & {
  mode: 'inline' | 'agent'; instruction: string;
  /** 0.4.3, default off: the adapter allows pytest, python -m pytest, git status and git diff (no shell
   * operators, 0.4.4) itself and reports them with command_request.autoApproved. Everything else, unrestricted
   * commands and edits are never auto-approved. */
  autoApproveSafeCommands?: boolean;
  /** 0.4.4: most run_command calls this turn may present (prompted or auto-approved); later ones are refused to
   * the model without prompting and reported with command_budget_reached. Default 3 for agent, 1 for inline. */
  commandBudget?: number;
};
export type SessionStatus = {
  sessionId: SessionId; state: 'open' | 'closed'; activeTurnId: string | null;
};
export type CancelStatus = 'confirmed' | 'already_terminal' | 'unconfirmed';
// Local adapter methods. Only envelopes and individual events cross a transport.
export interface ForgeHarness {
  start(bridge: EditorBridge): Promise<void>;
  createSession(req: Request<{ workspaceRoot: string }>): Promise<Response<SessionStatus>>;
  submitTurn(req: Request<TurnRequest>): Promise<Response<TurnRef>>;
  stream(req: Request<TurnRef & { afterSequence: number }>): AsyncIterable<Response<HarnessEvent>>;
  submitReview(req: Request<ReviewDecision>): Promise<Response<null>>;
  cancel(req: Request<TurnRef>): Promise<Response<CancelStatus>>;
  getSessionStatus(req: Request<{ sessionId: SessionId }>): Promise<Response<SessionStatus>>;
  closeSession(req: Request<{ sessionId: SessionId }>): Promise<Response<SessionStatus>>;
  dispose(): Promise<void>;
}
