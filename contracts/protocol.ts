export const PROTOCOL_VERSION = '0.4.8' as const;
export type Version = typeof PROTOCOL_VERSION;
export type SessionId = string;
export type TurnId = string;
export type CallId = string;
export type ProposalId = string;
export type TurnRef = { sessionId: SessionId; turnId: TurnId };
export type CallRef = TurnRef & { callId: CallId };
export type Request<T> = { version: Version; requestId: string; body: T };
export type Response<T> = { version: Version; requestId: string } & (
  | { ok: true; body: T }
  | { ok: false; error: ProtocolError }
);
export type ProtocolError = {
  code: 'version' | 'invalid' | 'unavailable' | 'model' | 'tool' | 'denied'
    | 'stale' | 'cancelled' | 'timeout' | 'conflict' | 'stream_gap' | 'internal';
  message: string;
  retryable: boolean;
  workspaceEffect: 'unchanged' | 'changed' | 'unknown';
};
