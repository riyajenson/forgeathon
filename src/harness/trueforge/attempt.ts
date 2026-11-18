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
  | { t: 'status'; state: 'running' | 'paused' | 'compacting' };

export interface AttemptResult {
  status: 'done' | 'cancelled' | 'error';
  message?: string;
  cancelReason?: string;
  /** The watchdog stopped this attempt. */
  watchdog: boolean;
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
  watchdogMs: number;
  cancelTimeoutMs: number;
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
  private readonly flushed = new Set<string>();
  private pending: PendingCall[] = [];
  private lastEventId: string | undefined;
  private runtimeTurnId: string | undefined;
  private cancelRequested = false;
  private watchdogFired = false;
  private watchdog: NodeJS.Timeout | undefined;
  private awaitingUser = false;
  private finished: AttemptResult | undefined;
  private resolveFinished!: (r: AttemptResult) => void;
  private readonly finishedPromise = new Promise<AttemptResult>((r) => { this.resolveFinished = r; });
  private resolveCancelSignal!: () => void;
  private readonly cancelSignal = new Promise<'cancelled'>((r) => { this.resolveCancelSignal = () => r('cancelled'); });

  constructor(private readonly o: AttemptOptions) {}

  get isFinished(): boolean {
    return this.finished !== undefined;
  }

  async run(): Promise<AttemptResult> {
    try {
      const result = await this.drive();
      return this.finish(result);
    } catch (e) {
      return this.finish({ status: 'error', message: (e as Error).message, watchdog: this.watchdogFired });
    } finally {
      this.clearWatchdog();
    }
  }

  /** Idempotent. Resolves when TrueForge confirms (turn.done) or after cancelTimeoutMs. */
  async cancel(): Promise<CancelStatus> {
    if (this.finished) return this.finished.status === 'cancelled' && this.cancelRequested ? 'confirmed' : 'already_terminal';
    const first = !this.cancelRequested;
    this.cancelRequested = true;
    this.resolveCancelSignal();
    if (first) {
      try {
        await this.o.client.sessions.cancel(this.o.runtimeSessionId);
      } catch {
        // Confirmation can only come from the stream; keep observing.
      }
    }
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((r) => { timer = setTimeout(() => r('timeout'), this.o.cancelTimeoutMs); });
    const outcome = await Promise.race([this.finishedPromise, timeout]);
    clearTimeout(timer);
    if (outcome === 'timeout') return 'unconfirmed';
    return outcome.status === 'cancelled' ? 'confirmed' : 'already_terminal';
  }

  private finish(result: AttemptResult): AttemptResult {
    if (!this.finished) {
      this.finished = { ...result, ...(this.runtimeTurnId ? { runtimeTurnId: this.runtimeTurnId } : {}) };
      this.resolveFinished(this.finished);
    }
    return this.finished;
  }

  private armWatchdog(): void {
    this.clearWatchdog();
    if (this.awaitingUser || this.cancelRequested) return;
    this.watchdog = setTimeout(() => {
      this.watchdogFired = true;
      void this.cancel();
    }, this.o.watchdogMs);
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
      { maxRetries: 0 },
    );
    if (this.cancelRequested) void client.sessions.cancel(runtimeSessionId).catch(() => undefined);
    let outcome = await this.consume(stream as AsyncIterable<unknown>);

    for (;;) {
      if (outcome.kind === 'done') return this.resultFrom(outcome.event);
      if (!this.runtimeTurnId || !this.lastEventId) throw new Error('turn stream ended before the turn was created');
      if (outcome.kind === 'ended') {
        // The connection dropped without a terminal event: resume once from the last event we saw.
        const sub = await client.sessions.subscribeToTurn(runtimeSessionId, this.runtimeTurnId, { afterEventId: this.lastEventId }, { maxRetries: 0 });
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
      const sub = await client.sessions.subscribeToTurn(runtimeSessionId, this.runtimeTurnId, { afterEventId: this.lastEventId }, { maxRetries: 0 });
      if (decisions !== 'cancelled' && !this.cancelRequested) {
        await client.sessions.createTurnEvents(runtimeSessionId, this.runtimeTurnId, {
          events: decisions.map((d) => ({
            type: 'user.tool_approval' as const,
            threadId: d.threadId,
            toolCallId: d.id,
            approval: d.allow ? { status: 'allow' as const } : { status: 'deny' as const, reason: d.reason },
          })),
        }, { maxRetries: 0 });
      }
      this.armWatchdog();
      outcome = await this.consume(sub as AsyncIterable<unknown>);
    }
  }

  private async consume(stream: AsyncIterable<unknown>): Promise<ConsumeOutcome> {
    for await (const raw of stream) {
      const event = raw as TfEvent;
      this.armWatchdog();
      if (this.o.sdk.isEventDelta(event as never)) {
        const base = this.messages.get(event.id);
        if (base) this.o.sdk.mergeEventDelta(base as never, event as never);
        else this.messages.set(event.id, { ...structuredClone(event), type: 'model.message' });
        const delta = event['content'];
        if (typeof delta === 'string' && delta) this.o.onEvent({ t: 'text', messageId: event.id, delta });
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
          if (typeof content === 'string' && content) this.o.onEvent({ t: 'text', messageId: event.id, delta: content });
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
          this.o.onEvent({ t: 'status', state: 'compacting' });
          break;
        case 'thread.context_compaction_finished':
          this.o.onEvent({ t: 'status', state: 'running' });
          break;
        case 'turn.done':
          return { kind: 'done', event };
        default:
          break;
      }
    }
    return { kind: 'ended' };
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
    const base = { watchdog: this.watchdogFired, ...(usage ? { usage } : {}) };
    if (status === 'done') return { ...base, status: 'done', ...(typeof output?.content === 'string' ? { summary: output.content } : {}) };
    if (status === 'cancelled') return { ...base, status: 'cancelled', cancelReason: String(state['reason'] ?? '') };
    return { ...base, status: 'error', message: String(state['message'] ?? 'turn failed') };
  }
}
