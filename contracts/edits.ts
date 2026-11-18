import type { CallRef, ProposalId } from './protocol';

export type Hunk = {
  hunkId: string;
  startOffset: number;
  endOffset: number;
  oldText: string;
  newText: string;
};
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
// The adapter constructs the approved replacement from the reviewed proposal.
export type ApprovedApplication = CallRef & {
  kind: 'apply_approved';
  proposalId: ProposalId;
  acceptedHunkIds: readonly [string, ...string[]];
};
/** For saved edits, expectedPostSha256 reflects the post-save buffer, including save participants. */
export type UndoReceipt = { undoId: string; path: string; expectedPostSha256: string };
export type ApplyTextRequest = ApprovedApplication & {
  path: string; expectedSha256: string | null; text: string; textSha256: string;
};
type Applied = {
  appliedHunkIds: readonly string[];
  undo: UndoReceipt; // post-apply buffer hash plus editor-local inverse handle
};
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
export interface EditorBridge {
  /** Open document text (dirty or not), else disk; null only if the file does not exist. */
  readText(path: string): Promise<{ text: string; sha256: string } | null>;
  listFiles(options?: { prefix?: string; limit?: number }): Promise<readonly string[]>;
  /** A known outcome returns a result. A throw means the workspace effect is unknown. */
  applyText(request: ApplyTextRequest): Promise<ApplyTextResult>;
  log(level: 'info' | 'warn' | 'error', message: string): void;
}
