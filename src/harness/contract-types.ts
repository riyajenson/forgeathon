// Local mirror of the shared contracts (contracts/, protocol 0.3.0) plus the accepted amendments R1–R5.
// This is the ONLY file that defines contract shapes inside the harness. When the amended contracts land,
// this file becomes re-exports from ../../contracts and nothing else changes.

// ---- protocol.ts
export const PROTOCOL_VERSION = '0.3.0' as const;
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

// ---- context.ts (+R4 skipped)
export type SourceRange = { startLine: number; endLine: number };
export type SymbolLocation = SourceRange & { path: string; name: string };
export type Reference = { kind: 'file'; path: string } | { kind: 'symbol'; name: string };
export type PromptContext = {
  activeFile?: string;
  selection?: SourceRange & { path: string; text: string };
  references?: readonly Reference[];
};
export type ContextReport = {
  budgetTokens: number;
  estimatedTokens: number;
  selections: readonly {
    path: string;
    symbol?: string;
    range?: SourceRange;
    source: 'active' | 'selection' | 'explicit' | 'automatic';
    rank: number;
    rationale: string;
    estimatedTokens: number;
    truncated: boolean;
  }[];
  skipped: readonly { path: string; reason: string; estimatedTokens: number }[];
};

// ---- edits.ts (+R1 bridge, R2 ApplyResult, R5 text-carrying request, save-formatter undo rule)
export type Hunk = { hunkId: string; startOffset: number; endOffset: number; oldText: string; newText: string };
export type FileBase = { isNewFile: false; baseSha256: string } | { isNewFile: true; baseSha256: null };
export type EditProposal = CallRef & FileBase & {
  kind: 'proposal';
  proposalId: ProposalId;
  path: string;
  originalText: string;
  proposedText: string;
  hunks: readonly Hunk[];
  summary: string;
};
export type ReviewDecision = CallRef & (
  | { kind: 'edit'; proposalId: ProposalId; hunks: Readonly<Record<string, 'accept' | 'reject'>>; reason?: string }
  | { kind: 'command'; allow: boolean; reason?: string }
);
export type ApprovedApplication = CallRef & {
  kind: 'apply_approved';
  proposalId: ProposalId;
  acceptedHunkIds: readonly [string, ...string[]];
};
/** expectedPostSha256 is the buffer hash after apply, or after save when a save participant changed the text. */
export type UndoReceipt = { undoId: string; path: string; expectedPostSha256: string };
/** R5: the editor verifies expectedSha256 and writes `text` verbatim; acceptedHunkIds are for display/undo only. */
export type ApplyTextRequest = ApprovedApplication & {
  path: string;
  expectedSha256: string | null;
  text: string;
  textSha256: string;
};
type Applied = { appliedHunkIds: readonly string[]; undo: UndoReceipt };
export type ApplyTextResult = CallRef & { proposalId: string; path: string } & (
  | { status: 'stale'; expectedSha256: string | null; observedSha256: string | null }
  | { status: 'approval_missing' }
  | { status: 'failed_before_apply'; message: string }
  | (Applied & { status: 'buffer_applied'; save: 'deferred'; reason: string })
  | (Applied & { status: 'save_failed'; message: string; currentBufferSha256: string;
                 disk: 'unchanged' | 'unknown'; recovery: 'inspect_buffer_then_retry_save' })
  | (Applied & { status: 'saved'; savedTextSha256: string })
);
export type ApplyResult = ApplyTextResult;
export type ListFilesOptions = { prefix?: string; limit?: number };
export interface EditorBridge {
  /** Open document text (dirty or not), else disk; null only if the file does not exist. */
  readText(path: string): Promise<{ text: string; sha256: string } | null>;
  listFiles(options?: ListFilesOptions): Promise<readonly string[]>;
  /** Must not throw for a known outcome; a throw means the workspace effect is unknown. */
  applyText(request: ApplyTextRequest): Promise<ApplyTextResult>;
  log(level: 'info' | 'warn' | 'error', message: string): void;
}

// ---- tools.ts (+R3 context, list)
type Operations = {
  read: [{ path: string }, { text: string; sha256: string }];
  search: [{ query: string; limit: number }, { matches: readonly { path: string; line: number; excerpt: string }[] }];
  symbol: [{ name: string; limit: number }, { matches: readonly SymbolLocation[] }];
  propose_edit: [EditProposal, { result: ApplyResult }];
  terminal: [{ command: string; cwd: string }, { stdout: string; stderr: string; exitCode: number | null }];
  context: [{ query: string; budgetTokens: number }, { report: ContextReport }];
  list: [{ prefix?: string; limit: number }, { paths: readonly string[] }];
};
export type ToolId = keyof Operations;

// ---- events.ts
export type EventBody =
  | { t: 'session'; agentName: string; model: string; traceUrl: string; runtimeSessionId: string }
  | { t: 'turn_started' }
  | { t: 'status'; state: 'starting' | 'running' | 'awaiting_review' | 'retrying' | 'fallback' | 'compacting' | 'cancelling'; detail?: string }
  | { t: 'text'; messageId: string; delta: string }
  | { t: 'tool_call'; callId: CallId; tool: ToolId | 'internal'; displayName: string; summary: string; requiresApproval: boolean }
  | { t: 'tool_result'; callId: CallId; ok: boolean; summary: string }
  | { t: 'context_report'; report: ContextReport }
  | { t: 'review_request'; proposal: EditProposal }
  | { t: 'command_request'; callId: CallId; command: string; cwd: string }
  | { t: 'edit_applied'; result: ApplyResult }
  | { t: 'fallback'; fromModel: string; toModel: string; reason: string }
  | { t: 'error'; error: ProtocolError }
  | { t: 'done'; status: 'done' | 'cancelled' | 'error'; summary?: string; usage?: { inputTokens: number; outputTokens: number } };
export type HarnessEvent = TurnRef & { version: Version; sequence: number } & EventBody;

// ---- session.ts
export type TurnRequest = TurnRef & PromptContext & { mode: 'inline' | 'agent'; instruction: string };
export type SessionStatus = { sessionId: SessionId; state: 'open' | 'closed'; activeTurnId: string | null };
export type CancelStatus = 'confirmed' | 'already_terminal' | 'unconfirmed';
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
