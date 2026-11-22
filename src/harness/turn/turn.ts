// One application turn: runs TrueForge attempts, the review/command approval flow, retry and fallback,
// and translates everything into the shared HarnessEvent stream.
import type { CancelStatus, EditProposal, EventBody, ProtocolError, ReviewDecision, TurnRequest } from '../contract-types';
import { approvalKey, buildProposal, hunkId, type ProposeEditArgs } from '../mcp/tools';
import { isAutoApprovableCommand, isListedCommand, isTestCommand, UNRESTRICTED_WARNING } from '../mcp/command';
import type { EditorPort } from '../mcp/port';
import type { ScopeRegistry, SessionScope } from '../mcp/scope';
import { canonicalArgsKey, deletedDefinitions } from '../review';
import { testOutcome, type TestOutcome } from './test-outcome';
import { Attempt, type AttemptResult, type CallDecision, type PendingCall } from '../trueforge/attempt';
import { classifyTurnError, connectionCause, isRateLimited, isTrueForgeUnreachable, redactSecrets, retryDelayMs, safeMessage } from '../trueforge/errors';
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
  /** Silence limit while a model request is in flight (default 120 s in the harness). */
  modelWatchdogMs?: number;
  contextBudgetTokens: number;
  retryDelayMs: number;
  settleMs: number;
  /** JSON-lines turn log (no content); undefined disables it. */
  turnLogPath?: string | undefined;
  /** Set when this turn resumes an interrupted one (TurnRequest.resumeOf). */
  resumeFrom?: ResumeFrom | undefined;
}

/** What a resumed turn inherits from the turn that stopped on a rate limit or a stall. */
export interface ResumeFrom {
  turnId: string;
  /** Why the interrupted turn stopped. */
  reason?: 'rate_limited' | 'stalled';
  /** Files the interrupted turn changed (applied edits, and files commands changed). */
  changedFiles: string[];
  commandsUsed: number;
  testsUsed: number;
  /** The agent the interrupted turn was running on when it stopped (`…-fallback` after a fallback), and its TrueForge
   * session: Resume continues that conversation, not the primary's. */
  agentName?: string;
  runtimeSessionId?: string;
}

/** Suggested wait before Resume after a rate limit: NVIDIA's free tier sends no Retry-After. */
export const RESUME_WAIT_MS = 60_000;

/** Suggested wait before Resume after a stall: the model answered nothing, so there is no limit to wait out. */
export const RESUME_AFTER_STALL_MS = 5_000;

/** Put before the original request when a turn resumes one that stopped on a rate limit or a stall. */
export function resumeNote(from: Pick<ResumeFrom, 'changedFiles' | 'reason'>): string {
  const why = from.reason === 'stalled' ? 'the model stopped responding (no output within the time limit)' : 'the model provider rate-limited requests (HTTP 429)';
  const changed = from.changedFiles.length
    ? `Already changed in that turn: ${from.changedFiles.join(', ')}. Those files now differ from what you read earlier: ` +
      're-read only the line ranges you are about to edit (for their exact text and sha256) and do not redo changes that are already there.'
    : 'No file was changed in that turn.';
  return `Resumed turn: your previous turn on this task stopped early because ${why}. ` +
    `${changed} Commands already run in that turn count against this turn's limits. Continue from where it stopped and finish the task.\n\nOriginal request:`;
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
export const DEFAULT_COMMAND_BUDGET = { agent: 3, inline: 1 } as const;

export function commandBudgetOf(req: Pick<TurnRequest, 'mode' | 'commandBudget'>): number {
  const b = req.commandBudget;
  return typeof b === 'number' && Number.isInteger(b) && b >= 0 ? b : DEFAULT_COMMAND_BUDGET[req.mode];
}

export const COMMAND_BUDGET_EXHAUSTED =
  'command budget for this turn exhausted; stop running commands, finish edits and summarize';

/** Default most test runs (pytest, python -m pytest) per turn, counted separately from other commands (0.4.5). */
export const DEFAULT_TEST_COMMAND_BUDGET = { agent: 3, inline: 1 } as const;

export function testCommandBudgetOf(req: Pick<TurnRequest, 'mode' | 'testCommandBudget'>): number {
  const b = req.testCommandBudget;
  return typeof b === 'number' && Number.isInteger(b) && b >= 0 ? b : DEFAULT_TEST_COMMAND_BUDGET[req.mode];
}

export const TEST_BUDGET_EXHAUSTED =
  'test-command budget for this turn exhausted; do not run more tests, finish edits and summarize with the last test result';

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
  private readonly log = { retries: 0, fallback: false, toolCalls: 0, reviews: 0, commandPrompts: 0, autoApproved: 0, budgetRefused: 0, testBudgetRefused: 0, subagents: 0, attempts: [] as AttemptRecord[] };
  /** run_command calls presented (prompted or auto-approved) this turn, counted against the command budget. */
  private commandsUsed = 0;
  /** Test runs presented this turn, counted against the test-command budget. */
  private testsUsed = 0;
  /** The observed outcome of the last test command that ran in this turn. */
  private lastTest: TestOutcome | undefined;
  /** Files saved or applied after the last test command: its result may no longer hold. */
  private readonly editedAfterTest = new Set<string>();
  /** Files this turn changed: applied edits and files reported changed by commands. */
  private readonly changedFiles = new Set<string>();
  /** Set when the turn stopped on a rate limit and emitted `resumable`. */
  private resumableState: ResumeFrom | undefined;
  private resumedBy: string | undefined;
  /** Files with a propose_edit refused this turn for an argument error. */
  private readonly argumentErrors = new Set<string>();

  constructor(readonly req: TurnRequest, private readonly deps: TurnDeps) {
    this.buffer = new TurnEventBuffer({ sessionId: req.sessionId, turnId: req.turnId });
    if (deps.resumeFrom) {
      // A resumed turn continues the interrupted one: same limits used, same files already changed.
      this.commandsUsed = deps.resumeFrom.commandsUsed;
      this.testsUsed = deps.resumeFrom.testsUsed;
      for (const f of deps.resumeFrom.changedFiles) this.changedFiles.add(f);
    }
  }

  /** What a Resume of this turn inherits; undefined unless it stopped on a rate limit and was not resumed yet. */
  get resumable(): ResumeFrom | undefined {
    return this.done && !this.resumedBy ? this.resumableState : undefined;
  }

  /** Marks this turn as resumed by `turnId`: a turn can be resumed once. */
  markResumed(turnId: string): void {
    this.resumedBy = turnId;
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
      budgetRefusedTests: this.log.testBudgetRefused, subagents: this.log.subagents,
      ...(this.req.resumeOf ? { resumeOf: this.req.resumeOf } : {}), ...(this.resumableState ? { resumable: true } : {}),
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

  /** Start cancellation synchronously and acknowledge without waiting for stream confirmation. */
  requestCancel(): CancelStatus {
    if (this.done) return 'already_terminal';
    void this.cancel().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.port.log('error', `cancellation request failed: ${message}`);
    });
    // The caller must keep consuming the event stream. Only its terminal `done` event confirms the outcome.
    return 'unconfirmed';
  }

  // ------------------------------------------------------------------ main loop

  private async run(): Promise<void> {
    const emit = this.buffer.emit.bind(this.buffer);
    emit({ t: 'turn_started' });
    emit({ t: 'status', state: 'starting' });
    const built = await buildTurnInput(this.req, this.deps.port, this.deps.contextBudgetTokens, this.contextAbort.signal, {
      onSemanticProgress: (event) => {
        const progress = typeof event.progress === 'number' ? ` (${Math.floor(event.progress)}%)` : '';
        const file = event.file ?? event.name;
        emit({ t: 'status', state: 'starting', detail: `Loading local context model${progress}${file ? ` · ${file}` : ''}` });
      },
    });
    const { context } = built;
    const input = this.deps.resumeFrom ? `${resumeNote(this.deps.resumeFrom)}\n${built.input}` : built.input;
    if (this.deps.resumeFrom) {
      const n = this.deps.resumeFrom.changedFiles.length;
      const why = this.deps.resumeFrom.reason === 'stalled' ? 'stopped responding' : 'stopped on a rate limit';
      const where = this.deps.resumeFrom.agentName?.endsWith(FALLBACK_SUFFIX) ? ' on the fallback model' : '';
      emit({ t: 'status', state: 'starting', detail: `Resuming the turn that ${why} (${n} file${n === 1 ? '' : 's'} already changed)${where}` });
    }
    if (context) emit({ t: 'context_report', report: context.report });

    // A resumed turn continues on the agent and in the TrueForge session where the interrupted turn stopped: after a
    // fallback that is the fallback's conversation (the primary had already failed, and the edits were made there).
    const from = this.deps.resumeFrom;
    let agent = from?.agentName ?? this.deps.agentName;
    let onFallback = agent === `${this.deps.agentName}${FALLBACK_SUFFIX}`;
    let resumeSession = from?.agentName !== undefined ? from.runtimeSessionId : undefined;
    let retried = false;
    let fresh = false;
    for (;;) {
      if (this.cancelRequested) return this.finishCancelled();
      let runtimeSessionId: string;
      try {
        const reuse = resumeSession !== undefined && !fresh ? resumeSession : undefined;
        resumeSession = undefined;
        runtimeSessionId = reuse ?? await this.deps.runtimeSession(agent, fresh);
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
      scope.onApplied = (result) => {
        if (result.status === 'saved' || result.status === 'buffer_applied' || result.status === 'save_failed') {
          this.changedFiles.add(result.path);
          if (this.lastTest) this.editedAfterTest.add(result.path);
        }
        emit({ t: 'edit_applied', result });
      };
      scope.workspaceRoot = this.deps.workspaceRoot;
      scope.onContext = (report) => emit({ t: 'context_report', report });
      scope.onCommand = (r) => {
        for (const f of r.changedFiles) this.changedFiles.add(f);
        if (isTestCommand(r.command)) { this.lastTest = testOutcome(r.command, r.exitCode, r.output ?? ''); this.editedAfterTest.clear(); }
        else if (this.lastTest) for (const f of r.changedFiles) this.editedAfterTest.add(f);
        emit({
          t: 'status', state: 'running',
          detail: (r.changedFiles.length
            ? `command exited ${r.exitCode ?? 'without code'}; it changed files outside review: ${r.changedFiles.join(', ')}`
            : `command exited ${r.exitCode ?? 'without code'}; no files changed`).slice(0, 300),
        });
      };
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
        return void emit({ t: 'done', status: 'error', ...this.testsField() });
      }
      const wrote = scope.writes > 0;
      // An approved write or command that had not finished counts as a write: no retry, no fallback.
      const mayHaveWritten = wrote || unexecuted > 0 || !settled;
      const effect: ProtocolError['workspaceEffect'] = !settled ? 'unknown' : wrote ? 'changed' : 'unchanged';

      if (result.status === 'done' || (result.status === 'cancelled' && this.cancelRequested)) {
        this.record(agent, model, runtimeSessionId, result, attemptStart);
      }
      if (result.status === 'done') {
        return void emit({ t: 'done', status: 'done', ...(result.summary ? { summary: result.summary.slice(0, 2000) } : {}), ...(result.usage ? { usage: result.usage } : {}), ...this.testsField() });
      }
      if (result.status === 'cancelled' && this.cancelRequested) {
        if (result.unconfirmed) emit({ t: 'status', state: 'cancelling', detail: 'stopped locally; TrueForge did not confirm in time. No further edits or commands will run.' });
        return this.finishCancelled(result);
      }

      // Failure: model error, watchdog stop, or a cancellation we did not ask for.
      const message = result.watchdog
        ? `no response from the model for ${Math.round((result.watchdogLimitMs ?? this.deps.watchdogMs) / 1000)} s`
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
      const rateLimited = cls === 'MODEL_UNAVAILABLE' && isRateLimited(result.message);
      // A stall after writes is otherwise a dead end (no retry or fallback after a write): offer Resume as well.
      const stalled = result.watchdog && mayHaveWritten;
      if ((rateLimited || stalled) && !this.cancelRequested) {
        // The editor may offer Resume: a new turn on the same conversation, told what this one already changed.
        const reason = rateLimited ? 'rate_limited' as const : 'stalled' as const;
        this.resumableState = { turnId: this.req.turnId, reason, changedFiles: [...this.changedFiles].sort(), commandsUsed: this.commandsUsed, testsUsed: this.testsUsed, agentName: agent, runtimeSessionId };
        emit({ t: 'resumable', reason, retryAfterMs: rateLimited ? Math.max(RESUME_WAIT_MS, retryDelayMs(result.message, 0)) : RESUME_AFTER_STALL_MS, changedFiles: this.resumableState.changedFiles });
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
      ...(this.deps.modelWatchdogMs ? { modelWatchdogMs: this.deps.modelWatchdogMs } : {}),
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
            if (e.state === 'compacting' || e.state === 'running') emit({ t: 'status', state: e.state, ...(e.detail ? { detail: e.detail } : {}) });
            break;
          case 'subagent': {
            if (e.phase === 'started') this.log.subagents++;
            const task = e.task ? redactSecrets(e.task.replace(/\s+/g, ' ').trim()).slice(0, 200) : undefined;
            const error = e.error ? safeMessage(e.error) : undefined;
            emit({ t: 'subagent', phase: e.phase, threadId: e.threadId, name: e.name.slice(0, 80), ...(task ? { task } : {}),
              ...(e.ok === undefined ? {} : { ok: e.ok }), ...(error ? { error } : {}) });
            emit({ t: 'status', state: 'running', detail: (e.phase === 'started'
              ? `Delegated to sub-agent "${e.name}"${task ? `: ${task}` : ''}`
              : `Sub-agent "${e.name}" ${e.ok ? 'finished' : `failed${error ? `: ${error}` : ''}`}`).slice(0, 300) });
            break;
          }
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
          hunks: p.hunks.map((h) => {
            const deletes = deletedDefinitions(p.originalText, { startOffset: h.start, endOffset: h.end, newText: h.newText });
            return { hunkId: hunkId(call.id, h.index), startOffset: h.start, endOffset: h.end, oldText: h.oldText, newText: h.newText, ...(deletes.length ? { deletes } : {}) };
          }),
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
        // Hard per-turn limits, enforced here rather than trusted to the instructions: refused without a prompt.
        // Test runs and other commands have separate budgets, so a debug command cannot use up the test reruns.
        const test = isTestCommand(command);
        const budget = test ? testCommandBudgetOf(this.req) : commandBudgetOf(this.req);
        if ((test ? this.testsUsed : this.commandsUsed) >= budget) {
          if (test) this.log.testBudgetRefused++; else this.log.budgetRefused++;
          this.buffer.emit({ t: 'command_budget_reached', callId: call.id, command, budget, kind: test ? 'test' : 'other' });
          deny(test
            ? `TEST_BUDGET_EXHAUSTED: ${TEST_BUDGET_EXHAUSTED} (limit ${budget} test runs per turn; nothing was run)`
            : `COMMAND_BUDGET_EXHAUSTED: ${COMMAND_BUDGET_EXHAUSTED} (limit ${budget} per turn, test runs not included; nothing was run)`);
          continue;
        }
        if (test) this.testsUsed++; else this.commandsUsed++;
        this.buffer.emit({ t: 'status', state: 'awaiting_review', detail: command.slice(0, 120) });
        const listed = isListedCommand(command);
        if (this.req.autoApproveSafeCommands === true && isAutoApprovableCommand(command)) {
          // Opt-in: pytest / python -m pytest / git status / git diff (no shell operators) run without a prompt, and are shown.
          this.log.autoApproved++;
          this.buffer.emit({ t: 'command_request', callId: call.id, command, cwd, autoApproved: true });
          scope.commands.record(approvalKey('run_command', call.toolArgs), { callRef: { sessionId: this.req.sessionId, turnId: this.req.turnId, callId: call.id }, command, cwd });
          decisions.push({ id: call.id, threadId: call.threadId, allow: true });
          continue;
        }
        this.log.commandPrompts++;
        this.buffer.emit({ t: 'command_request', callId: call.id, command, cwd, ...(listed ? {} : { unrestricted: true, warning: UNRESTRICTED_WARNING }) });
        const d = await this.waitFor(call.id, { kind: 'command', hunkIds: [] });
        if (d === 'cancelled' || d.kind !== 'command') return 'cancelled';
        if (!d.allow) { deny(d.reason ? `user refused to run the command: ${d.reason}` : 'user refused to run the command'); continue; }
        scope.commands.record(approvalKey('run_command', call.toolArgs), { callRef: { sessionId: this.req.sessionId, turnId: this.req.turnId, callId: call.id }, command, cwd });
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
    this.buffer.emit({ t: 'done', status: 'cancelled', ...(result?.usage ? { usage: result.usage } : {}), ...this.testsField() });
  }

  private fail(error: ProtocolError): void {
    this.buffer.emit({ t: 'error', error });
    this.buffer.emit({ t: 'done', status: 'error', ...this.testsField() });
  }

  /** done.tests for agent turns: the last test command's observed outcome, or not_run. */
  private testsField(): { tests?: NonNullable<Extract<EventBody, { t: 'done' }>['tests']> } {
    if (this.req.mode !== 'agent') return {};
    const t = this.lastTest;
    if (!t) return { tests: { status: 'not_run' } };
    return { tests: { status: t.status, command: t.command.slice(0, 200), exitCode: t.exitCode,
      ...(t.passed !== undefined ? { passed: t.passed } : {}), ...(t.failed !== undefined ? { failed: t.failed } : {}), ...(t.summary ? { summary: t.summary } : {}),
      ...(this.editedAfterTest.size ? { editedAfter: [...this.editedAfterTest].sort() } : {}) } };
  }
}
