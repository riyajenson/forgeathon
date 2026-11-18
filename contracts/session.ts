import type { PromptContext } from './context';
import type { EditorBridge, ReviewDecision } from './edits';
import type { HarnessEvent } from './events';
import type { Request, Response, SessionId, TurnRef } from './protocol';

export type TurnRequest = TurnRef & PromptContext & { mode: 'inline' | 'agent'; instruction: string };
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
