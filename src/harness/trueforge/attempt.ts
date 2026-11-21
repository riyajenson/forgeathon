// One TrueForge turn on one runtime session: stream, approval round trip, cancel, watchdog.
// Emits internal events only; the turn controller maps them to the shared contract.
import type { CancelStatus } from '../contract-types';
import { effectiveToolArgs, DEFERRED_CALL_TOOL } from '../review';
import type { TfEvent, TfToolCall, TrueForgeClient, TrueForgeSdk } from './sdk';

export interface ToolCallInfo {
  id: string;
  /** Name the model called (e.g. propose_edit, call_tool, get_current_datetime). */
  name: string;
  /** Effective tool: the inner tool for deferred call_tool calls. */
  tool: string;
  /** Arguments the effective tool receives (inner `input` for call_tool). */
  toolArgs: unknown;
  /** MCP server of the effective tool, if any. */
  server: string | undefined;
}

export interface PendingCall extends ToolCallInfo {
  threadId: string;
}

export type CallDecision = { id: string; threadId: string; allow: true } | { id: string; threadId: string; allow: false; reason: string };

export type AttemptEvent =
  | { t: 'turn_created'; runtimeTurnId: string }
  | { t: 'text'; messageId: string; delta: string }
  | { t: 'tool_call'; call: ToolCallInfo }
  | { t: 'tool_result'; callId: string; ok: boolean; content: string }
  | { t: 'status'; state: 'running' | 'paused' | 'compacting'; detail?: string }
  | { t: 'subagent'; phase: 'started' | 'finished'; threadId: string; name: string; task?: string; ok?: boolean; error?: string };

export interface AttemptResult {
  status: 'done' | 'cancelled' | 'error';
  message?: string;
  cancelReason?: string;
  /** The watchdog stopped this attempt. */
  watchdog: boolean;
  /** The silence limit that fired (watchdog only): the model-request limit or the general one. */
  watchdogLimitMs?: number;
  /** Stopped locally because TrueForge did not confirm a cancel in time; its turn may still be running. */
  unconfirmed?: boolean;
  summary?: string;
  usage?: { inputTokens: number; outputTokens: number };
  runtimeTurnId?: string;
}

export interface AttemptOptions {
  sdk: TrueForgeSdk;
  client: TrueForgeClient;
  runtimeSessionId: string;
  input: string;
  onEvent(event: AttemptEvent): void;
  /** Resolve with one decision per call, or 'cancelled' if the turn was cancelled meanwhile. */
  onApprovals(calls: PendingCall[]): Promise<CallDecision[] | 'cancelled'>;
  /** Silence limit outside model requests (TrueForge internals between steps). */
  watchdogMs: number;
  /** Silence limit while a model request is in flight (a long generation can stream nothing for a while). Default watchdogMs. */
  modelWatchdogMs?: number;
  cancelTimeoutMs: number;
  /** True while one of our MCP tools is running for this attempt: TrueForge is silent then, so the watchdog waits. */
  isBusy?: () => boolean;
}

type ConsumeOutcome = { kind: 'paused' } | { kind: 'done'; event: TfEvent } | { kind: 'ended' };

export function describeToolCall(call: TfToolCall): ToolCallInfo {
  const name = call.function?.name ?? call.toolInfo?.name ?? 'unknown';
  let args: unknown = {};
  try {
    args = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
  } catch {
    args = { _unparsed: call.function?.arguments };
  }
  if (name === DEFERRED_CALL_TOOL && args && typeof args === 'object') {
    const a = args as Record<string, unknown>;
    return { id: call.id, name, tool: String(a['tool_name'] ?? 'unknown'), toolArgs: effectiveToolArgs(name, args), server: typeof a['mcp_server'] === 'string' ? a['mcp_server'] : undefined };
  }
  const isMcp = call.toolInfo?.type === 'mcp';
  return { id: call.id, name, tool: isMcp ? (call.toolInfo?.name ?? name) : name, toolArgs: args, server: isMcp ? call.toolInfo?.serverName : undefined };
}

/** TrueForge reports failed and denied tool calls as JSON with an `error` key. */
export function isErrorContent(content: string): boolean {
  try {
    const v = JSON.parse(content) as unknown;
    return v !== null && typeof v === 'object' && 'error' in (v as object);
  } catch {
    return false;
  }
}

export class Attempt {
  private readonly messages = new Map<string, TfEvent>();
  /** Sub-agent threads (thread.created with a parent) → their names. Their text is not the turn's reply. */
  private readonly childThreads = new Map<string, string>();
  private readonly flushed = new Set<string>();
  private pending: PendingCall[] = [];
  private lastEventId: string | undefined;
  private runtimeTurnId: string | undefined;
  private cancelRequested = false;
  private watchdogFired = false;
  private watchdogLimitMs: number | undefined;
  /** True from the turn start, a tool result, a compaction or the approvals until the next complete model.message. */
  private modelInFlight = true;
  private watchdog: NodeJS.Timeout | undefined;
  private awaitingUser = false;
  private finished: AttemptResult | undefined;
  private resolveFinished!: (r: AttemptResult) => void;
  private readonly finishedPromise = new Promise<AttemptResult>((r) => { this.resolveFinished = r; });
  private resolveCancelSignal!: () => void;
  private readonly cancelSignal = new Promise<'cancelled'>((r) => { this.resolveCancelSignal = () => r('cancelled'); });
  /** Aborts every TrueForge request of this attempt (stream reads included) when it is force-stopped. */
  private readonly abort = new AbortController();
  private hardStop: NodeJS.Timeout | undefined;

  constructor(private readonly o: AttemptOptions) {}

  get isFinished(): boolean {
    return this.finished !== undefined;
  }

  private get streamOptions() {
    return { maxRetries: 0, abortSignal: this.abort.signal };
  }

  async run(): Promise<AttemptResult> {
    const driving = this.drive();
    driving.catch(() => undefined); // after a forced stop its rejection is expected and ignored
    try {
      // A forced stop resolves finishedPromise even while drive() is stuck on a silent request.
      const result = await Promise.race([driving, this.finishedPromise]);
      return this.finish(result);
    } catch (e) {
      return this.finish({ status: 'error', message: (e as Error).message, watchdog: this.watchdogFired, ...(this.watchdogLimitMs ? { watchdogLimitMs: this.watchdogLimitMs } : {}) });
    } finally {
      this.clearWatchdog();
    }
  }

  /**
   * Idempotent. Resolves when TrueForge confirms (turn.done) or after cancelTimeoutMs ('unconfirmed'). Every
   * wait is bounded: if TrueForge has not ended the turn after another cancelTimeoutMs, the attempt stops
   * observing it, aborts its requests and finishes as cancelled with `unconfirmed`.
   */
  async cancel(): Promise<CancelStatus> {
    if (this.finished) return this.finished.status === 'cancelled' && this.cancelRequested && !this.finished.unconfirmed ? 'confirmed' : 'already_terminal';
    const first = !this.cancelRequested;
    this.cancelRequested = true;
    this.resolveCancelSignal();
    this.clearWatchdog();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((r) => { timer = setTimeout(() => r('timeout'), this.o.cancelTimeoutMs); });
    if (first) {
      this.hardStop = setTimeout(() => this.forceStop(), this.o.cancelTimeoutMs * 2);
      // Not awaited on its own: a silent server must not hold the cancel; confirmation comes from the stream.
      const timeoutInSeconds = Math.max(1, Math.ceil(this.o.cancelTimeoutMs / 1000));
      void Promise.resolve()
        .then(() => this.o.client.sessions.cancel(this.o.runtimeSessionId, undefined, { maxRetries: 0, timeoutInSeconds }))
        .catch(() => undefined);
    }
    const outcome = await Promise.race([this.finishedPromise, timeout]);
    clearTimeout(timer);
    if (outcome === 'timeout') return 'unconfirmed';
    return outcome.status === 'cancelled' && !outcome.unconfirmed ? 'confirmed' : outcome.unconfirmed ? 'unconfirmed' : 'already_terminal';
  }

  private forceStop(): void {
    if (this.finished) return;
    this.abort.abort();
    this.finish({ status: 'cancelled', cancelReason: 'TrueForge did not confirm the stop', watchdog: this.watchdogFired, unconfirmed: true, ...(this.watchdogLimitMs ? { watchdogLimitMs: this.watchdogLimitMs } : {}) });
  }

  private finish(result: AttemptResult): AttemptResult {
    if (!this.finished) {
      this.finished = { ...result, ...(this.runtimeTurnId ? { runtimeTurnId: this.runtimeTurnId } : {}) };
      if (this.hardStop) clearTimeout(this.hardStop);
      this.resolveFinished(this.finished);
    }
    return this.finished;
  }

  private armWatchdog(): void {
    this.clearWatchdog();
    if (this.awaitingUser || this.cancelRequested) return;
    const limit = this.modelInFlight ? (this.o.modelWatchdogMs ?? this.o.watchdogMs) : this.o.watchdogMs;
    this.watchdog = setTimeout(() => {
      if (this.o.isBusy?.()) return this.armWatchdog(); // a tool (e.g. pytest) is still running: not a stall
      this.watchdogFired = true;
      this.watchdogLimitMs = limit;
      void this.cancel();
    }, limit);
  }

  /** Tracks whether TrueForge is waiting on a model request, which decides the silence limit. */
  private noteProgress(event: TfEvent): void {
    switch (event.type) {
      // TrueForge emits a placeholder model.message (id and model only) when a request starts, streams deltas,
      // then the complete message: only the complete one ends the request.
      case 'model.message': {
        const tc = event['toolCalls'] as unknown[] | undefined;
        this.modelInFlight = !(event['finishReason'] != null || event['content'] || tc?.length || event['usage']);
        break;
      }
      case 'turn.created': case 'tool.response': case 'thread.context_compaction_started':
      case 'thread.context_compaction_finished': case 'thread.created': case 'thread.done':
        this.modelInFlight = true; break;
      case 'turn.update':
        if ((event['state'] as { status?: string } | undefined)?.status === 'running') this.modelInFlight = true;
        break;
    }
  }

  private clearWatchdog(): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = undefined;
  }

  private async drive(): Promise<AttemptResult> {
    const { client, runtimeSessionId } = this.o;
    this.armWatchdog();
    const stream = await client.sessions.createTurnStream(
      runtimeSessionId,
      { input: [{ type: 'user.message', content: this.o.input }] },
      this.streamOptions,
    );
    if (this.cancelRequested) {
      void client.sessions.cancel(runtimeSessionId, undefined, { maxRetries: 0, timeoutInSeconds: Math.max(1, Math.ceil(this.o.cancelTimeoutMs / 1000)) }).catch(() => undefined);
    }
    let outcome = await this.consume(stream as AsyncIterable<unknown>);

    for (;;) {
      if (outcome.kind === 'done') return this.resultFrom(outcome.event);
      if (!this.runtimeTurnId || !this.lastEventId) throw new Error('turn stream ended before the turn was created');
      if (outcome.kind === 'ended') {
        // The connection dropped without a terminal event: resume once from the last event we saw.
        const sub = await client.sessions.subscribeToTurn(runtimeSessionId, this.runtimeTurnId, { afterEventId: this.lastEventId }, this.streamOptions);
        outcome = await this.consume(sub as AsyncIterable<unknown>);
        if (outcome.kind === 'ended') throw new Error('turn stream ended without a terminal event');
        continue;
      }

      // Paused: collect decisions, then subscribe → send → read so nothing is missed.
      const calls = this.pending;
      this.pending = [];
      this.awaitingUser = true;
      this.clearWatchdog();
      const decisions = this.cancelRequested ? 'cancelled' : await Promise.race([this.o.onApprovals(calls), this.cancelSignal]);
      this.awaitingUser = false;
      this.modelInFlight = true; // the approved tools run, then the model is called again
      this.armWatchdog(); // from here on TrueForge must answer; a silent server is a stall
      const sub = await client.sessions.subscribeToTurn(runtimeSessionId, this.runtimeTurnId, { afterEventId: this.lastEventId }, this.streamOptions);
      if (decisions !== 'cancelled' && !this.cancelRequested) {
        await client.sessions.createTurnEvents(runtimeSessionId, this.runtimeTurnId, {
          events: decisions.map((d) => ({
            type: 'user.tool_approval' as const,
            threadId: d.threadId,
            toolCallId: d.id,
            approval: d.allow ? { status: 'allow' as const } : { status: 'deny' as const, reason: d.reason },
          })),
        }, this.streamOptions);
      }
      this.armWatchdog();
      outcome = await this.consume(sub as AsyncIterable<unknown>);
    }
  }

  private async consume(stream: AsyncIterable<unknown>): Promise<ConsumeOutcome> {
    for await (const raw of stream) {
      const event = raw as TfEvent;
      if (!this.o.sdk.isEventDelta(event as never)) this.noteProgress(event);
      this.armWatchdog();
      if (this.o.sdk.isEventDelta(event as never)) {
        const base = this.messages.get(event.id);
        if (base) this.o.sdk.mergeEventDelta(base as never, event as never);
        else this.messages.set(event.id, { ...structuredClone(event), type: 'model.message' });
        const delta = event['content'];
        if (typeof delta === 'string' && delta && !this.isChild(event)) this.o.onEvent({ t: 'text', messageId: event.id, delta });
        continue;
      }
      this.lastEventId = event.id;
      if (event.type !== 'model.message') this.flushToolCalls();
      switch (event.type) {
        case 'turn.created':
          this.runtimeTurnId = String(event['turnId']);
          this.o.onEvent({ t: 'turn_created', runtimeTurnId: this.runtimeTurnId });
          break;
        case 'model.message': {
          this.flushToolCalls();
          this.messages.set(event.id, structuredClone(event));
          const content = event['content'];
          if (typeof content === 'string' && content && !this.isChild(event)) this.o.onEvent({ t: 'text', messageId: event.id, delta: content });
          break;
        }
        case 'thread.created': {
          const parent = event['parent'] as { threadId?: string } | undefined;
          if (!parent?.threadId) break; // the main thread
          const threadId = String(event['threadId']);
          const info = (event['agentInfo'] ?? {}) as { name?: unknown; input?: unknown };
          const name = typeof info.name === 'string' && info.name ? info.name : String(event['title'] ?? threadId);
          this.childThreads.set(threadId, name);
          this.o.onEvent({ t: 'subagent', phase: 'started', threadId, name, ...(typeof info.input === 'string' ? { task: info.input } : {}) });
          break;
        }
        case 'thread.done': {
          const threadId = String(event['threadId']);
          const name = this.childThreads.get(threadId);
          if (name === undefined) break; // the main thread
          const state = (event['state'] ?? {}) as { status?: unknown; error?: unknown };
          const ok = state.status === 'done';
          this.o.onEvent({ t: 'subagent', phase: 'finished', threadId, name, ok, ...(!ok && typeof state.error === 'string' ? { error: state.error } : {}) });
          break;
        }
        case 'tool.response': {
          const content = typeof event['content'] === 'string' ? event['content'] : JSON.stringify(event['content']);
          this.o.onEvent({ t: 'tool_result', callId: String(event['toolCallId']), ok: !isErrorContent(content), content });
          break;
        }
        case 'tool.approval_required': {
          const threadId = String(event['threadId']);
          for (const ref of (event['toolCalls'] as Array<{ id: string; sourceEventId: string }>) ?? []) {
            const source = this.messages.get(ref.sourceEventId);
            const tc = ((source?.['toolCalls'] as TfToolCall[] | undefined) ?? []).find((c) => c.id === ref.id);
            const info = tc ? describeToolCall(tc) : { id: ref.id, name: 'unknown', tool: 'unknown', toolArgs: {}, server: undefined };
            this.pending.push({ ...info, threadId });
          }
          break;
        }
        case 'turn.update': {
          const status = (event['state'] as { status?: string } | undefined)?.status;
          if (status === 'paused') {
            this.o.onEvent({ t: 'status', state: 'paused' });
            return { kind: 'paused' };
          }
          if (status === 'running') this.o.onEvent({ t: 'status', state: 'running' });
          break;
        }
        case 'thread.context_compaction_started':
          this.o.onEvent({ t: 'status', state: 'compacting', detail: compactionStarted(event) });
          break;
        case 'thread.context_compaction_finished':
          this.o.onEvent({ t: 'status', state: 'running', detail: compactionFinished(event) });
          break;
        case 'turn.done':
          return { kind: 'done', event };
        default:
          break;
      }
    }
    return { kind: 'ended' };
  }

  private isChild(event: TfEvent): boolean {
    const threadId = event['threadId'];
    return typeof threadId === 'string' && this.childThreads.has(threadId);
  }

  /** Emits tool_call once per tool call, after its model.message is complete. */
  private flushToolCalls(): void {
    for (const [id, msg] of this.messages) {
      if (this.flushed.has(id)) continue;
      this.flushed.add(id);
      for (const tc of (msg['toolCalls'] as TfToolCall[] | undefined) ?? []) this.o.onEvent({ t: 'tool_call', call: describeToolCall(tc) });
    }
  }

  private resultFrom(done: TfEvent): AttemptResult {
    const state = (done['state'] ?? {}) as Record<string, unknown>;
    const metrics = (state['metrics'] ?? {}) as Record<string, unknown>;
    const usage = typeof metrics['totalInputTokens'] === 'number'
      ? { inputTokens: metrics['totalInputTokens'] as number, outputTokens: (metrics['totalOutputTokens'] as number | undefined) ?? 0 }
      : undefined;
    const output = state['output'] as { content?: unknown } | undefined;
    const status = state['status'];
    const base = { watchdog: this.watchdogFired, ...(this.watchdogLimitMs ? { watchdogLimitMs: this.watchdogLimitMs } : {}), ...(usage ? { usage } : {}) };
    if (status === 'done') return { ...base, status: 'done', ...(typeof output?.content === 'string' ? { summary: output.content } : {}) };
    if (status === 'cancelled') return { ...base, status: 'cancelled', cancelReason: String(state['reason'] ?? '') };
    return { ...base, status: 'error', message: String(state['message'] ?? 'turn failed') };
  }
}

const tokens = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '?');

/** Panel status line for TrueForge's thread.context_compaction_started (fields as the SDK deserializes them). */
export function compactionStarted(event: TfEvent): string {
  const trigger = event['trigger'] as { contextTokens?: number; thresholdTokens?: number } | undefined;
  return `Compacting context: ${tokens(trigger?.contextTokens)} tokens reached the ${tokens(trigger?.thresholdTokens)}-token threshold`;
}

/** Panel status line for thread.context_compaction_finished: the summary call's size and time. */
export function compactionFinished(event: TfEvent): string {
  const usage = event['usage'] as { inputTokens?: number; outputTokens?: number } | undefined;
  const ms = event['durationMs'];
  const secs = typeof ms === 'number' && Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)} s` : '? s';
  return `Context compacted in ${secs}: ${tokens(usage?.inputTokens)} tokens summarized into ${tokens(usage?.outputTokens)}`;
}
