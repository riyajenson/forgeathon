# Harness reference requirements (contract v0.2 text as received)

Status: reference requirements for the harness, not the shared contract. The shared contracts are
authored by the editor team in `contracts/` and reviewed in `docs/harness/contract-review.md`.

Note: the text below is reproduced exactly as received on 2026-11-18. It was truncated in transit
partway through section 3 ("A FIFO queue per key"); nothing after that point was received.

---

```text
TRUEFORGE VS CODE AGENT — INTEGRATION CONTRACT v0.2 (harness ↔ editor)
(v0.1 + changes verified by spike against TrueForge 0.185.1)

OWNERSHIP
- Harness (Claude Code): src/harness/** (TrueForge adapter, MCP server+tools, context engine,
  review core), agent/*.json, scripts/**, config/*.example.json. Shared types: src/shared/contract.ts
  (harness drafts; changes only by mutual agreement).
- Editor (Codex): commands, keybindings, inline UX, panel/webview, diff rendering, per-hunk controls,
  cancellation UI, undo, and the EditorBridge implementation.
- Working copy: WSL clone ~/projects/forgeathon (core.autocrlf=input). VS Code via Remote-WSL.
  Harness branch: harness/core. Editor work on its own branch; merge at integration.

RUNTIME
- TrueForge 0.185.1 local at http://127.0.0.1:8790 (setting forge.trueforgeUrl), started by user:
  OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1"]' MODEL_HTTP_CONNECT_TIMEOUT_MS=3000 MODEL_HTTP_MAX_RETRIES=1 \
    npx -y @truefoundry/trueforge@0.185.1
- Extension hosts MCP server http://127.0.0.1:47615/mcp (forge.mcpPort), bearer-token header auth;
  harness registers it in TrueForge as connector "vscode".
- Extension NEVER calls a model provider. All model traffic goes through TrueForge.

1) HARNESS API (editor consumes)
interface ForgeHarness {
  start(bridge: EditorBridge): Promise<void>;   // MCP up, connector+agents upserted, health check
  runTurn(req: TurnRequest): TurnHandle;        // never throws; failures arrive as events
  dispose(): Promise<void>;
}
interface TurnRequest {
  mode: 'inline' | 'agent';
  instruction: string;            // raw text; may contain @file:<path> and @symbol:<Name>
  activeFile?: string;            // workspace-relative POSIX path
  selection?: { path: string; startLine: number; endLine: number; text: string }; // 1-based, inclusive
  sessionId?: string;             // continue an agent-panel conversation
}
interface TurnHandle {
  id: string;
  onEvent(cb: (e: HarnessEvent) => void): Disposable;
  submitReview(d: ReviewDecision): void;
  cancel(): Promise<void>;        // idempotent; resolves on TrueForge confirmation (~10-25 ms) or after 5s
}

2) EVENTS (harness → editor). Exactly one 'done' per turn, always last.
type HarnessEvent =
 | { t:'session'; sessionId:string; agentName:string; model:string; traceUrl:string }
 | { t:'status'; state:'starting'|'running'|'awaiting_review'|'retrying'|'fallback'|'compacting'|'cancelling'; detail?:string }
 | { t:'text'; messageId:string; delta:string }
 | { t:'tool_call'; callId:string; tool:string; args:unknown; requiresApproval:boolean }
 | { t:'tool_result'; callId:string; ok:boolean; summary:string }
 | { t:'context_report'; report: ContextReport }
 | { t:'review_request'; proposal: EditProposal }                    // turn paused until submitReview
 | { t:'command_request'; callId:string; command:string; cwd:string } // answer via submitReview(kind:'command')
 | { t:'edit_applied'; result: ApplyResult }
 | { t:'fallback'; fromModel:string; toModel:string; reason:string } // a new 'session' event follows
 | { t:'error'; code: ErrorCode; message:string; workspaceTouched:boolean }
 | { t:'done'; status:'done'|'cancelled'|'error'; summary?:string; usage?:{inputTokens:number; outputTokens:number} }
Notes: the editor renders 'fallback' as a visible banner:
"Primary model failed: <reason> → switched to <toModel>". 'tool_call' for the internal tools
(list_tools, get_tool_info, call_tool, get_current_datetime) is shown collapsed or hidden.

3) EDIT REVIEW
interface EditProposal {
  proposalId: string;              // = TrueForge tool_call_id
  path: string; isNewFile: boolean;
  baseSha256: string;              // sha of current buffer text (dirty buffers included)
  originalText: string; proposedText: string;
  hunks: Hunk[];                   // non-overlapping, file order
  summary: string;
}
interface Hunk { hunkId: string /* `${proposalId}#${i}` */; startLine: number; endLine: number; oldText: string; newText: string }
type ReviewDecision =
 | { kind:'edit'; proposalId:string; hunks: Record<string,'accept'|'reject'>; rejectReason?:string } // all hunks decided
 | { kind:'command'; callId:string; allow:boolean; reason?:string };
Rules:
- The editor renders the diff and collects decisions. It does NOT write in response to review.
- All rejected → harness denies the tool call (the model receives the reason). ≥1 accepted → harness
  allows; the MCP tool applies ONLY the accepted hunks via bridge.applyEdit.
- The MCP server receives no call id: decisions are matched by sha256 of the canonical JSON (sorted
  keys) of the tool arguments (for deferred calls: the inner `input`). A FIFO queue per key
```

[TRUNCATED IN TRANSIT — remainder not received]
