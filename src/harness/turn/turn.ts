// One application turn: runs TrueForge attempts, the review/command approval flow, retry and fallback,
// and translates everything into the shared HarnessEvent stream.
import type { CancelStatus, EditProposal, ProtocolError, ReviewDecision, TurnRequest } from '../contract-types';
import { approvalKey, buildProposal, hunkId, type ProposeEditArgs } from '../mcp/tools';
import { isAutoApprovableCommand, isListedCommand, UNRESTRICTED_WARNING } from '../mcp/command';
import type { EditorPort } from '../mcp/port';
import type { ScopeRegistry, SessionScope } from '../mcp/scope';
import { canonicalArgsKey } from '../review';
import { Attempt, type AttemptResult, type CallDecision, type PendingCall } from '../trueforge/attempt';
import { classifyTurnError, connectionCause, isRateLimited, isTrueForgeUnreachable, retryDelayMs, safeMessage } from '../trueforge/errors';
import { appendTurnLog, type AttemptRecord } from './turn-log';
import { traceUrl, type TrueForgeClient, type TrueForgeSdk } from '../trueforge/sdk';
import { TurnEventBuffer } from './event-buffer';
import { buildTurnInput } from './prompt';
import { APPROVAL_TOOLS, summarizeArgs, summarizeResult, toolIdOf } from './tool-map';

export interface TurnDeps {
  sdk: TrueForgeSdk;
  client: TrueForgeClient;
  port: EditorPort;
  scopes: ScopeRegistry;
  trueforgeUrl: string;
  /** Absolute workspace root of the application session. */
  workspaceRoot: string;
  /** Primary agent for this turn's mode. Its fallback is `${agent}-fallback`. */
  agentName: string;
  /** Runtime session for an agent: reused across the app session's turns unless `fresh`. */
  runtimeSession(agentName: string, fresh: boolean): Promise<string>;
  agentModel(agentName: string): Promise<string>;
  cancelTimeoutMs: number;
  watchdogMs: number;
  contextBudgetTokens: number;
  retryDelayMs: number;
  settleMs: number;
  /** JSON-lines turn log (no content); undefined disables it. */
  turnLogPath?: string | undefined;
}

type ReviewWaiter = {
  kind: 'edit' | 'command';
  hunkIds: string[];
  proposalId?: string;
  resolve(d: ReviewDecision | 'cancelled'): void;
  decided?: ReviewDecision;
};

export type ReviewSubmitResult = { ok: true } | { ok: false; error: ProtocolError };

const FALLBACK_SUFFIX = '-fallback';

/** Default most run_command calls per turn (presented to the user or auto-approved), by mode. */
export const DEFAULT_COMMAND_BUDGET = { agent: 5, inline: 1 } as const;

export function commandBudgetOf(req: Pick<TurnRequest, 'mode' | 'commandBudget'>): number {
  const b = req.commandBudget;
  return typeof b === 'number' && Number.isInteger(b) && b >= 0 ? b : DEFAULT_COMMAND_BUDGET[req.mode];
}

export const COMMAND_BUDGET_EXHAUSTED =
  'command budget for this turn exhausted; stop running commands, finish edits and summarize';

/**
 * Agent mode only: once the budget is used up, one rerun of a command that already ran this turn is still allowed
 * after an edit was approved since that command last ran, so a fix can always be checked once.
 */
export const RERUN_AFTER_FIX =
  'after your next fix you may rerun one test command that already ran this turn, once; nothing else';

/** Appended to the agent turn's message so the model plans its verification within the limit the harness enforces. */
export function commandBudgetNote(budget: number): string {
  return `Command budget for this turn: ${budget} run_command call(s). A refused command shape (cd prefix) does not count. ` +
    'Keep one run for the rerun after a fix; when the budget is used up, one rerun of a test command that already ran is still allowed after a fix.';
}

/** `cd <dir> && <command>` or `cd <dir>; <command>`: commands already start in the workspace root, and run_command takes a cwd. */
export function cdPrefix(command: string): { dir: string; rest: string } | undefined {
  const m = /^\s*cd\s+("[^"]*"|'[^']*'|[^\s;&|]+)\s*(?:&&|;)\s*(\S[\s\S]*)$/.exec(command);
  return m ? { dir: m[1]!.replace(/^["']|["']$/g, ''), rest: m[2]!.trim() } : undefined;
}

/** propose_edit refusals caused by the shape of the arguments rather than by the file's content. */
const ARGUMENT_ERROR_CODES = new Set(['INVALID_ARGS', 'INVALID_EDIT', 'OUTSIDE_WORKSPACE']);

/** Added to a repeated argument-error refusal for the same file in one turn. */
export const PROPOSE_EDIT_SHAPE_HINT =
  'Expected arguments, exactly this shape: {"path": "src/pkg/module.py", "base_sha256": "<sha256 from read_file; \\"\\" for a new file>", ' +
  '"edits": [{"old_text": "def f():\\n    return 1\\n", "new_text": "def f():\\n    return 2\\n"}], "summary": "one line"}. ' +
  '"edits" is a JSON array of objects (not a string); each old_text is copied verbatim from the file and matches once. ' +
  'Put every change to this file in that one call.';

export class TurnRun {
  readonly buffer: TurnEventBuffer;
  private attempt: Attempt | undefined;
  private scope: SessionScope | undefined;
  private cancelRequested = false;
  private readonly contextAbort = new AbortController();
  private cancelPromise: Promise<CancelStatus> | undefined;
  private wakeRetry: (() => void) | undefined;
  private readonly waiters = new Map<string, ReviewWaiter>();
  private readonly decided = new Map<string, ReviewDecision>();
  private finishedPromise: Promise<void> | undefined;
  private readonly log = { retries: 0, fallback: false, toolCalls: 0, reviews: 0, commandPrompts: 0, autoApproved: 0, budgetRefused: 0, attempts: [] as AttemptRecord[] };
  /** run_command calls presented (prompted or auto-approved) this turn, counted against the command budget. */
  private commandsUsed = 0;
  /** propose_edit calls approved (at least one hunk accepted) this turn. */
  private editsApproved = 0;
  /** For each command that ran this turn: editsApproved when it last ran. */
  private readonly commandRuns = new Map<string, number>();
  private rerunAfterFixUsed = false;
  /** Files with a propose_edit refused this turn for an argument error. */
  private readonly argumentErrors = new Set<string>();

  constructor(readonly req: TurnRequest, private readonly deps: TurnDeps) {
    this.buffer = new TurnEventBuffer({ sessionId: req.sessionId, turnId: req.turnId });
  }

  get done(): boolean {
    return this.buffer.isClosed;
  }

  start(): Promise<void> {
    const t0 = Date.now();
    this.finishedPromise ??= this.run()
      .catch((e) => {
        this.fail({ code: 'internal', message: safeMessage((e as Error).message), retryable: false, workspaceEffect: 'unknown' });
      })
      .then(() => this.writeLog(Date.now() - t0));
    return this.finishedPromise;
  }

  private record(agent: string, model: string, runtimeSessionId: string, r: AttemptResult, since: number, errorClass?: string): void {
    this.log.attempts.push({
      agent, model, runtimeSessionId, status: r.status, ms: Date.now() - since,
      ...(errorClass ? { errorClass } : {}),
      ...(r.usage ? { inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens } : {}),
    });
  }

  private async writeLog(ms: number): Promise<void> {
    const done = this.buffer.snapshot().find((e) => e.t === 'done');
    const sum = (k: 'inputTokens' | 'outputTokens') => this.log.attempts.reduce((s, a) => s + (a[k] ?? 0), 0);
    await appendTurnLog(this.deps.turnLogPath, {
      time: new Date().toISOString(), sessionId: this.req.sessionId, turnId: this.req.turnId, mode: this.req.mode,
      status: done && done.t === 'done' ? done.status : 'error', ms, attempts: this.log.attempts,
      retries: this.log.retries, fallback: this.log.fallback, toolCalls: this.log.toolCalls, reviews: this.log.reviews,
      commandPrompts: this.log.commandPrompts, autoApprovedCommands: this.log.autoApproved, budgetRefusedCommands: this.log.budgetRefused,
      inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'),
    });
  }

  // ------------------------------------------------------------------ review & cancel (editor → harness)

  submitReview(d: ReviewDecision): ReviewSubmitResult {
    const invalid = (message: string): ReviewSubmitResult => ({ ok: false, error: { code: 'invalid', message, retryable: false, workspaceEffect: 'unchanged' } });
    if (d.sessionId !== this.req.sessionId || d.turnId !== this.req.turnId) return invalid('decision does not belong to this turn');
    const previous = this.decided.get(d.callId);
    if (previous) {
      return canonicalArgsKey(previous) === canonicalArgsKey(d)
        ? { ok: true }
        : { ok: false, error: { code: 'conflict', message: 'a different decision was already recorded for this call', retryable: false, workspaceEffect: 'unchanged' } };
    }
    const w = this.waiters.get(d.callId);
    if (!w) return { ok: false, error: { code: this.cancelRequested ? 'cancelled' : 'invalid', message: 'no review is pending for this call', retryable: false, workspaceEffect: 'unchanged' } };
    if (d.kind !== w.kind) return invalid(`expected a ${w.kind} decision`);
    if (d.kind === 'edit') {
      if (d.proposalId !== w.proposalId) return invalid('proposalId does not match the pending proposal');
      const ids = Object.keys(d.hunks);
      const unknown = ids.filter((id) => !w.hunkIds.includes(id));
      const missing = w.hunkIds.filter((id) => !(id in d.hunks));
      if (unknown.length) return invalid(`unknown hunk ids: ${unknown.join(', ')}`);
      if (missing.length) return invalid(`every hunk needs a decision; missing: ${missing.join(', ')}`);
    }
    this.decided.set(d.callId, d);
    this.waiters.delete(d.callId);
    w.resolve(d);
    return { ok: true };
  }

  cancel(): Promise<CancelStatus> {
    if (this.done) return Promise.resolve('already_terminal');
    this.cancelPromise ??= (async () => {
      this.cancelRequested = true;
      this.contextAbort.abort();
      this.buffer.emit({ t: 'status', state: 'cancelling' });
      this.scope?.cancel();
      for (const w of this.waiters.values()) w.resolve('cancelled');
      this.waiters.clear();
      this.wakeRetry?.();
      // Report an unconfirmed stop, but retain the session until every tool settles.
      const limit = this.deps.cancelTimeoutMs * 2 + this.deps.settleMs + 1000;
      const guard = setTimeout(() => {
        if (this.done) return;
        this.buffer.emit({ t: 'status', state: 'cancelling', detail: 'stopped locally; TrueForge did not confirm in time. No further edits or commands will run.' });
      }, limit);
      guard.unref?.();
      void this.finishedPromise?.finally(() => clearTimeout(guard));
      const attempt = this.attempt;
      if (!attempt || attempt.isFinished) {
        const finished = await Promise.race([
          (this.finishedPromise ?? Promise.resolve()).then(() => true),
          new Promise<false>((r) => setTimeout(() => r(false), this.deps.cancelTimeoutMs).unref?.()),
        ]);
        return finished ? 'confirmed' : 'unconfirmed';
      }
      return attempt.cancel();
    })();
    return this.cancelPromise;
  }

  // ------------------------------------------------------------------ main loop

  private async run(): Promise<void> {
    const emit = this.buffer.emit.bind(this.buffer);
    emit({ t: 'turn_started' });
    emit({ t: 'status', state: 'starting' });
    const { input: turnInput, context } = await buildTurnInput(this.req, this.deps.port, this.deps.contextBudgetTokens, this.contextAbort.signal, {
      onSemanticProgress: (event) => {
        const progress = typeof event.progress === 'number' ? ` (${Math.floor(event.progress)}%)` : '';
        const file = event.file ?? event.name;
        emit({ t: 'status', state: 'starting', detail: `Loading local context model${progress}${file ? ` · ${file}` : ''}` });
      },
    });
    if (context) emit({ t: 'context_report', report: context.report });
    const input = this.req.mode === 'agent' ? `${turnInput}\n\n${commandBudgetNote(commandBudgetOf(this.req))}` : turnInput;

    let agent = this.deps.agentName;
    let onFallback = false;
    let retried = false;
    let fresh = false;
    for (;;) {
      if (this.cancelRequested) return this.finishCancelled();
      let runtimeSessionId: string;
      try {
        runtimeSessionId = await this.deps.runtimeSession(agent, fresh);
      } catch (e) {
        // A connection-level failure creating the session (nothing has run yet) is retried once: a server that
        // answered the previous request can drop one connection under load. A second failure is reported.
        if (!isTrueForgeUnreachable(e) || this.cancelRequested) return this.fail(this.startError(e, agent));
        this.deps.port.log('warn', `creating a TrueForge session failed (${connectionCause(e)}); retrying once`);
        emit({ t: 'status', state: 'retrying', detail: `TrueForge connection failed (${connectionCause(e)}); retrying once in ${Math.round(this.deps.retryDelayMs / 100) / 10} s` });
        await this.sleep(this.deps.retryDelayMs);
        if (this.cancelRequested) return this.finishCancelled();
        try {
          runtimeSessionId = await this.deps.runtimeSession(agent, fresh);
        } catch (again) {
          this.deps.port.log('error', `creating a TrueForge session failed again (${connectionCause(again)})`);
          return this.fail(this.startError(again, agent));
        }
      }
      const model = await this.deps.agentModel(agent).catch(() => agent);
      emit({ t: 'session', agentName: agent, model, traceUrl: traceUrl(this.deps.trueforgeUrl, runtimeSessionId), runtimeSessionId });

      const scope = this.deps.scopes.open(runtimeSessionId);
      scope.resetForTurn();
      scope.semanticSearch = this.req.semanticSearch === true;
      scope.onApplied = (result) => emit({ t: 'edit_applied', result });
      scope.workspaceRoot = this.deps.workspaceRoot;
      scope.onContext = (report) => emit({ t: 'context_report', report });
      scope.onCommand = (r) => emit({
        t: 'status', state: 'running',
        detail: (r.changedFiles.length
          ? `command exited ${r.exitCode ?? 'without code'}; it changed files outside review: ${r.changedFiles.join(', ')}`
          : `command exited ${r.exitCode ?? 'without code'}; no files changed`).slice(0, 300),
      });
      this.scope = scope;
      if (this.cancelRequested) scope.cancel();

      const attemptStart = Date.now();
      const result = await this.runAttempt(runtimeSessionId, input, scope);
      // Wait (bounded) for our tool calls to settle before deciding anything.
      const settled = await scope.settle(this.deps.settleMs);
      // Approvals the attempt never used: close the gate so they can never be used later.
      const unexecuted = scope.closeApprovals();
      if (result.status !== 'done') scope.cancel();
      if (!settled) {
        // origin 45b3b9b: do not release the app session, reset approval state, or start another model while
        // an earlier operation can still complete. Cancellation closes tool admission first. The wait ends when
        // the tool does (a command is killed by its timeout, at most 600 s, or by Stop).
        this.deps.port.log('warn', `tool calls still running ${this.deps.settleMs} ms after the turn ended; holding the session until they finish`);
        scope.cancel();
        this.record(agent, model, runtimeSessionId, result, attemptStart, 'TOOLS_UNSETTLED');
        emit({ t: 'error', error: { code: 'unavailable', message: 'A tool is still running. Recovery is blocked until it finishes (no retry or fallback); inspect the workspace afterward.', retryable: false, workspaceEffect: 'unknown' } });
        emit({ t: 'status', state: 'cancelling', detail: `${scope.inFlightCount} tool call(s) still running after the turn ended; waiting for them. No retry or fallback will start.` });
        await scope.waitForIdle();
        if (this.cancelRequested) return this.finishCancelled(result);
        return void emit({ t: 'done', status: 'error' });
      }
      const wrote = scope.writes > 0;
      // An approved write or command that had not finished counts as a write: no retry, no fallback.
      const mayHaveWritten = wrote || unexecuted > 0 || !settled;
      const effect: ProtocolError['workspaceEffect'] = !settled ? 'unknown' : wrote ? 'changed' : 'unchanged';

      if (result.status === 'done' || (result.status === 'cancelled' && this.cancelRequested)) {
        this.record(agent, model, runtimeSessionId, result, attemptStart);
      }
      if (result.status === 'done') {
        return void emit({ t: 'done', status: 'done', ...(result.summary ? { summary: result.summary.slice(0, 2000) } : {}), ...(result.usage ? { usage: result.usage } : {}) });
      }
      if (result.status === 'cancelled' && this.cancelRequested) {
        if (result.unconfirmed) emit({ t: 'status', state: 'cancelling', detail: 'stopped locally; TrueForge did not confirm in time. No further edits or commands will run.' });
        return this.finishCancelled(result);
      }

      // Failure: model error, watchdog stop, or a cancellation we did not ask for.
      const message = result.watchdog
        ? `no response from the model for ${Math.round(this.deps.watchdogMs / 1000)} s`
        : result.status === 'cancelled' ? `TrueForge stopped the turn (${result.cancelReason || 'cancelled'})` : safeMessage(result.message);
      const cls = result.watchdog ? 'MODEL_UNAVAILABLE' : result.status === 'error' ? classifyTurnError(result.message) : 'OTHER';

      this.record(agent, model, runtimeSessionId, result, attemptStart, cls);
      if (!mayHaveWritten && !this.cancelRequested && cls !== 'OTHER') {
        if (cls === 'MODEL_UNAVAILABLE' && !retried && !onFallback) {
          retried = true;
          this.log.retries++;
          const delay = retryDelayMs(result.message, this.deps.retryDelayMs);
          const why = isRateLimited(result.message) ? 'rate limited' : message;
          emit({ t: 'status', state: 'retrying', detail: `${why}; retrying once in ${Math.round(delay / 100) / 10} s` });
          await this.sleep(delay);
          // A turn TrueForge never confirmed as stopped may still be running: retry in a new session.
          fresh = result.unconfirmed === true;
          continue;
        }
        if (!onFallback) {
          const toAgent = `${this.deps.agentName}${FALLBACK_SUFFIX}`;
          const toModel = await this.deps.agentModel(toAgent).catch(() => toAgent);
          emit({ t: 'status', state: 'fallback', detail: message });
          emit({ t: 'fallback', fromModel: model, toModel, reason: message });
          this.log.fallback = true;
          agent = toAgent;
          onFallback = true;
          fresh = true;
          continue;
        }
      }
      const code: ProtocolError['code'] = cls === 'MODEL_UNAVAILABLE' ? 'unavailable' : 'model';
      const prefix = cls === 'MODEL_AUTH' ? 'Model authentication failed' : cls === 'MODEL_UNAVAILABLE' ? 'Model unavailable' : cls === 'MODEL_OTHER' ? 'Model error' : 'Turn failed';
      const note = wrote ? ' (no retry or fallback: this turn already changed the workspace)'
        : mayHaveWritten ? ' (no retry or fallback: an approved change from this attempt had not finished)'
          : onFallback ? ' (fallback model also failed)' : '';
      return this.fail({ code, message: `${prefix}: ${message}${note}`, retryable: cls === 'MODEL_UNAVAILABLE' && !mayHaveWritten, workspaceEffect: effect });
    }
  }

  private async runAttempt(runtimeSessionId: string, input: string, scope: SessionScope): Promise<AttemptResult> {
    const emit = this.buffer.emit.bind(this.buffer);
    const attempt = new Attempt({
      sdk: this.deps.sdk,
      client: this.deps.client,
      runtimeSessionId,
      input,
      watchdogMs: this.deps.watchdogMs,
      cancelTimeoutMs: this.deps.cancelTimeoutMs,
      isBusy: () => scope.inFlightCount > 0,
      onEvent: (e) => {
        switch (e.t) {
          case 'text':
            emit({ t: 'text', messageId: e.messageId, delta: e.delta });
            break;
          case 'tool_call':
            this.log.toolCalls++;
            emit({
              t: 'tool_call', callId: e.call.id, tool: toolIdOf(e.call.tool), displayName: e.call.tool,
              summary: summarizeArgs(e.call.tool, e.call.toolArgs), requiresApproval: APPROVAL_TOOLS.has(e.call.tool),
            });
            break;
          case 'tool_result':
            emit({ t: 'tool_result', callId: e.callId, ok: e.ok, summary: summarizeResult(e.content) });
            break;
          case 'status':
            if (e.state === 'compacting') emit({ t: 'status', state: 'compacting' });
            else if (e.state === 'running') emit({ t: 'status', state: 'running' });
            break;
          case 'turn_created':
            emit({ t: 'status', state: 'running' });
            break;
        }
      },
      onApprovals: (calls) => this.decide(calls, scope),
    });
    this.attempt = attempt;
    if (this.cancelRequested) void attempt.cancel();
    try {
      return await attempt.run();
    } catch (e) {
      return { status: 'error', message: (e as Error).message, watchdog: false };
    }
  }

  /** Approval policy for one paused batch. Reviews are shown one at a time, in order. */
  private async decide(calls: PendingCall[], scope: SessionScope): Promise<CallDecision[] | 'cancelled'> {
    const decisions: CallDecision[] = [];
    const seen = new Set<string>();
    for (const call of calls) {
      if (this.cancelRequested) return 'cancelled';
      const deny = (reason: string) => decisions.push({ id: call.id, threadId: call.threadId, allow: false, reason });
      const key = `${call.tool}:${canonicalArgsKey(call.toolArgs)}`;
      if (seen.has(key)) { deny('duplicate of another identical call in the same step; only the first is considered'); continue; }
      seen.add(key);

      if (call.tool === 'propose_edit') {
        const args = call.toolArgs as ProposeEditArgs;
        const built = await buildProposal(this.deps.port, args);
        if (!built.ok) {
          let reason = `${built.code}: ${built.message}`;
          if (ARGUMENT_ERROR_CODES.has(built.code)) {
            const file = typeof args?.path === 'string' ? args.path.trim() : '';
            if (this.argumentErrors.has(file)) reason += `. ${PROPOSE_EDIT_SHAPE_HINT}`;
            this.argumentErrors.add(file);
          }
          deny(reason);
          continue;
        }
        const p = built.proposal;
        const callRef = { sessionId: this.req.sessionId, turnId: this.req.turnId, callId: call.id };
        const hunkIds = p.hunks.map((h) => hunkId(call.id, h.index));
        const base = p.isNewFile ? { isNewFile: true as const, baseSha256: null } : { isNewFile: false as const, baseSha256: p.baseSha256 ?? '' };
        const proposal: EditProposal = {
          ...callRef, ...base, kind: 'proposal', proposalId: call.id, path: p.path,
          originalText: p.originalText, proposedText: p.proposedText, summary: p.summary,
          hunks: p.hunks.map((h) => ({ hunkId: hunkId(call.id, h.index), startOffset: h.start, endOffset: h.end, oldText: h.oldText, newText: h.newText })),
        };
        this.buffer.emit({ t: 'status', state: 'awaiting_review', detail: p.path });
        this.log.reviews++;
        this.buffer.emit({ t: 'review_request', proposal });
        const d = await this.waitFor(call.id, { kind: 'edit', hunkIds, proposalId: call.id });
        if (d === 'cancelled' || d.kind !== 'edit') return 'cancelled';
        const acceptedIndices = p.hunks.filter((h) => d.hunks[hunkId(call.id, h.index)] === 'accept').map((h) => h.index);
        if (acceptedIndices.length === 0) { deny(d.reason ? `user rejected the change: ${d.reason}` : 'user rejected every hunk of this change'); continue; }
        scope.reviews.record(approvalKey('propose_edit', call.toolArgs), {
          callRef, proposalId: call.id, baseSha256: p.baseSha256, acceptedIndices,
          acceptedHunkIds: acceptedIndices.map((i) => hunkId(call.id, i)),
          ...(d.reason ? { rejectReason: d.reason } : {}),
        });
        this.editsApproved++;
        decisions.push({ id: call.id, threadId: call.threadId, allow: true });
        continue;
      }

      if (call.tool === 'run_command') {
        const a = (call.toolArgs ?? {}) as { command?: unknown; cwd?: unknown };
        const command = typeof a.command === 'string' ? a.command : '';
        const cwd = typeof a.cwd === 'string' && a.cwd ? a.cwd : '.';
        if (!command) { deny('INVALID_ARGS: command must be a non-empty string'); continue; }
        const cd = cdPrefix(command);
        if (cd) {
          // A shape the instructions rule out; refused before the budget and the user see it, with the corrected call.
          const where = cd.dir === '.' || cd.dir.startsWith('/') || cd.dir.startsWith('~') ? '' : ` and cwd "${cd.dir}"`;
          deny(`COMMAND_SHAPE: commands already start in the workspace root; drop the cd prefix and call run_command with command "${cd.rest}"${where}. Nothing was run and the command budget was not used.`);
          continue;
        }
        const budget = commandBudgetOf(this.req);
        const key = command.trim();
        const ranAt = this.commandRuns.get(key);
        const rerunAfterFix = this.commandsUsed >= budget && this.req.mode === 'agent' && !this.rerunAfterFixUsed &&
          ranAt !== undefined && this.editsApproved > ranAt;
        if (this.commandsUsed >= budget && !rerunAfterFix) {
          // Hard per-turn limit, enforced here rather than trusted to the instructions: refused without a prompt.
          this.log.budgetRefused++;
          this.buffer.emit({ t: 'command_budget_reached', callId: call.id, command, budget });
          const rerun = this.req.mode === 'agent' && !this.rerunAfterFixUsed && this.commandRuns.size > 0 ? `; ${RERUN_AFTER_FIX}` : '';
          deny(`COMMAND_BUDGET_EXHAUSTED: ${COMMAND_BUDGET_EXHAUSTED}${rerun} (limit ${budget} per turn; nothing was run)`);
          continue;
        }
        if (rerunAfterFix) this.rerunAfterFixUsed = true;
        else this.commandsUsed++;
        this.buffer.emit({ t: 'status', state: 'awaiting_review', detail: command.slice(0, 120) });
        const listed = isListedCommand(command);
        if (this.req.autoApproveSafeCommands === true && isAutoApprovableCommand(command)) {
          // Opt-in: pytest / python -m pytest / git status / git diff (no shell operators) run without a prompt, and are shown.
          this.log.autoApproved++;
          this.buffer.emit({ t: 'command_request', callId: call.id, command, cwd, autoApproved: true });
          scope.commands.record(approvalKey('run_command', call.toolArgs), { callRef: { sessionId: this.req.sessionId, turnId: this.req.turnId, callId: call.id }, command, cwd });
          this.commandRuns.set(key, this.editsApproved);
          decisions.push({ id: call.id, threadId: call.threadId, allow: true });
          continue;
        }
        this.log.commandPrompts++;
        this.buffer.emit({ t: 'command_request', callId: call.id, command, cwd, ...(listed ? {} : { unrestricted: true, warning: UNRESTRICTED_WARNING }) });
        const d = await this.waitFor(call.id, { kind: 'command', hunkIds: [] });
        if (d === 'cancelled' || d.kind !== 'command') return 'cancelled';
        if (!d.allow) { deny(d.reason ? `user refused to run the command: ${d.reason}` : 'user refused to run the command'); continue; }
        scope.commands.record(approvalKey('run_command', call.toolArgs), { callRef: { sessionId: this.req.sessionId, turnId: this.req.turnId, callId: call.id }, command, cwd });
        this.commandRuns.set(key, this.editsApproved);
        decisions.push({ id: call.id, threadId: call.threadId, allow: true });
        continue;
      }

      deny(`${call.tool} is not permitted to run with approval in this editor`);
    }
    if (!this.cancelRequested) this.buffer.emit({ t: 'status', state: 'running' });
    return this.cancelRequested ? 'cancelled' : decisions;
  }

  private waitFor(callId: string, w: Omit<ReviewWaiter, 'resolve'>): Promise<ReviewDecision | 'cancelled'> {
    if (this.cancelRequested) return Promise.resolve('cancelled');
    return new Promise((resolve) => this.waiters.set(callId, { ...w, resolve }));
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.wakeRetry = undefined; resolve(); }, ms);
      this.wakeRetry = () => { clearTimeout(timer); this.wakeRetry = undefined; resolve(); };
    });
  }

  private startError(e: unknown, agent: string): ProtocolError {
    if (isTrueForgeUnreachable(e)) {
      return { code: 'unavailable', message: `TrueForge is not reachable at ${this.deps.trueforgeUrl}`, retryable: true, workspaceEffect: 'unchanged' };
    }
    const status = (e as { statusCode?: number }).statusCode;
    const hint = status === 404 ? ` (agent "${agent}" not found; run the setup script)` : '';
    return { code: 'unavailable', message: `Could not start a TrueForge session${hint}: ${safeMessage((e as Error).message)}`, retryable: false, workspaceEffect: 'unchanged' };
  }

  private finishCancelled(result?: AttemptResult): void {
    this.buffer.emit({ t: 'done', status: 'cancelled', ...(result?.usage ? { usage: result.usage } : {}) });
  }

  private fail(error: ProtocolError): void {
    this.buffer.emit({ t: 'error', error });
    this.buffer.emit({ t: 'done', status: 'error' });
  }
}
