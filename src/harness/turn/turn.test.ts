// TurnRun against an in-memory stand-in for the TrueForge client: deterministic races that a real server
// cannot reproduce on demand (late tool calls, silent servers, approvals that were never executed).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { PROTOCOL_VERSION, type HarnessEvent, type ReviewDecision, type TurnRequest } from '../contract-types';
import type { ContextAssemblyOptions } from '../context';
import { FakePort } from '../mcp/fake-port';
import { ScopeRegistry, type SessionScope } from '../mcp/scope';
import { proposeEditTool } from '../mcp/tools';
import { runCommandTool } from '../mcp/command';
import { sha256Hex } from '../review';
import type { TrueForgeClient, TrueForgeSdk } from '../trueforge/sdk';
import { isTestCommand } from '../mcp/command';
import { buildTurnInput } from './prompt';
import { cdPrefix, COMMAND_BUDGET_EXHAUSTED, commandBudgetOf, PROPOSE_EDIT_SHAPE_HINT, RESUME_AFTER_STALL_MS, RESUME_WAIT_MS, resumeNote, TEST_BUDGET_EXHAUSTED, testCommandBudgetOf, TurnRun, type TurnDeps } from './turn';

/** An async event stream the test feeds by hand. Aborting the request signal ends it with an error. */
class Channel implements AsyncIterable<unknown> {
  private readonly items: unknown[] = [];
  private wake: (() => void) | undefined;
  private ended = false;
  private failed: Error | undefined;

  constructor(signal?: AbortSignal) {
    signal?.addEventListener('abort', () => { this.failed = new Error('aborted'); this.wake?.(); });
  }

  push(...events: unknown[]): void {
    this.items.push(...events);
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<unknown> {
    for (;;) {
      if (this.items.length) { yield this.items.shift(); continue; }
      if (this.failed) throw this.failed;
      if (this.ended) return;
      await new Promise<void>((r) => { this.wake = r; });
      this.wake = undefined;
    }
  }
}

let eid = 0;
const ev = (type: string, extra: Record<string, unknown> = {}) => ({ type, id: `e${++eid}`, ...extra });
const done = (status: 'done' | 'error' | 'cancelled', message?: string) =>
  ev('turn.done', { state: { status, ...(message ? { message } : {}), ...(status === 'done' ? { output: { content: 'finished' } } : {}) } });

/** turn.created, a model message with one tool call, and the approval pause for it. */
function toolCallNeedingApproval(callId: string, tool: string, args: unknown): unknown[] {
  const msg = ev('model.message', { toolCalls: [{ id: callId, function: { name: tool, arguments: JSON.stringify(args) }, toolInfo: { type: 'mcp', name: tool, serverName: 'vscode' } }] });
  return [
    ev('turn.created', { turnId: 'rt-1' }),
    msg,
    ev('tool.approval_required', { threadId: 'th-1', toolCalls: [{ id: callId, sourceEventId: msg.id }] }),
    ev('turn.update', { state: { status: 'paused' } }),
  ];
}

interface Script {
  /** A new turn stream for attempt `n` (1-based) on `sessionId`. */
  onTurn(ch: Channel, n: number, sessionId: string): void;
  /** The user's approvals arrived; `sub` is the stream TrueForge continues on. */
  onApproval?(sub: Channel, sessionId: string): void;
  /** sessions.cancel; default: confirm on the active stream. */
  onCancel?(active: Channel | undefined): Promise<unknown>;
}

class FakeTrueForge {
  turns = 0;
  cancels = 0;
  /** Every user.tool_approval sent back to TrueForge, in order. */
  readonly approvals: Array<{ toolCallId: string; threadId?: string; approval: { status: string; reason?: string } }> = [];
  /** The user message of every turn started, in order. */
  readonly inputs: string[] = [];
  /** The request body of every createTurnStream call (the turn's input). */
  readonly turnRequests: unknown[] = [];
  private active: Channel | undefined;
  constructor(private readonly script: Script) {}

  readonly client = {
    sessions: {
      createTurnStream: async (sessionId: string, req: { input?: Array<{ content?: string }> }, opts?: { abortSignal?: AbortSignal }) => {
        this.inputs.push(req?.input?.[0]?.content ?? '');
        this.turnRequests.push(req);
        const ch = new Channel(opts?.abortSignal);
        this.active = ch;
        this.script.onTurn(ch, ++this.turns, sessionId);
        return ch;
      },
      subscribeToTurn: async (_s: string, _t: string, _req: unknown, opts?: { abortSignal?: AbortSignal }) => {
        const ch = new Channel(opts?.abortSignal);
        this.active = ch;
        return ch;
      },
      createTurnEvents: async (sessionId: string, _turnId: string, body?: { events?: FakeTrueForge['approvals'] }) => {
        this.approvals.push(...(body?.events ?? []));
        this.script.onApproval?.(this.active!, sessionId);
        return {};
      },
      cancel: async () => {
        this.cancels++;
        if (this.script.onCancel) return this.script.onCancel(this.active);
        this.active?.push(done('cancelled'));
        return {};
      },
    },
  };
}

const sdk = { isEventDelta: () => false, mergeEventDelta: () => undefined } as unknown as TrueForgeSdk;
const FILE = 'src/app.py';
const ORIGINAL = 'def alpha():\n    return 1\n';
let root: string;
let port: FakePort;
let scopes: ScopeRegistry;
let sessionsCreated: string[];
let n = 0;

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-turn-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
});
after(async () => { await fs.rm(root, { recursive: true, force: true }); });
beforeEach(async () => {
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, FILE), ORIGINAL);
  await fs.rm(path.join(root, 'ran.txt'), { force: true });
  port = new FakePort(root);
  scopes = new ScopeRegistry();
  sessionsCreated = [];
});

function makeRun(tf: FakeTrueForge, overrides: Partial<TurnDeps> = {}, request: Record<string, unknown> = {}): TurnRun {
  const id = `t${++n}`;
  const reuse = new Map<string, string>();
  return new TurnRun({ sessionId: 's', turnId: id, mode: 'agent', instruction: 'change alpha', ...request }, {
    sdk, client: tf.client as unknown as TrueForgeClient, port, scopes,
    trueforgeUrl: 'http://127.0.0.1:1', workspaceRoot: root, agentName: 'coder',
    runtimeSession: async (agent, fresh) => {
      const existing = reuse.get(agent);
      if (existing && !fresh) return existing;
      const s = `rs-${agent}-${sessionsCreated.length + 1}`;
      sessionsCreated.push(s);
      reuse.set(agent, s);
      return s;
    },
    agentModel: async (agent) => agent,
    cancelTimeoutMs: 150, watchdogMs: 5000, contextBudgetTokens: 2000, retryDelayMs: 10, settleMs: 200,
    turnLogPath: undefined,
    ...overrides,
  });
}

/** Accepts every review and allows every command, like a user clicking through. */
async function clickThrough(run: TurnRun, onDecided?: () => void): Promise<void> {
  for await (const e of run.buffer.read(0)) {
    let d: ReviewDecision | undefined;
    if (e.t === 'review_request') {
      const p = e.proposal;
      d = { kind: 'edit', sessionId: p.sessionId, turnId: p.turnId, callId: p.callId, proposalId: p.proposalId, hunks: Object.fromEntries(p.hunks.map((h) => [h.hunkId, 'accept'])) };
    } else if (e.t === 'command_request') {
      d = { kind: 'command', sessionId: e.sessionId, turnId: e.turnId, callId: e.callId, allow: true };
    }
    if (d) { assert.deepEqual(run.submitReview(d), { ok: true }); onDecided?.(); }
  }
}

const editArgs = () => ({ path: FILE, base_sha256: sha256Hex(ORIGINAL), edits: [{ old_text: '    return 1', new_text: '    return 10' }] });
const events = (run: TurnRun): readonly HarnessEvent[] => run.buffer.snapshot();
const terminal = (run: TurnRun) => events(run).filter((e) => e.t === 'done');
const lastError = (run: TurnRun) => events(run).filter((e) => e.t === 'error').pop() as Extract<HarnessEvent, { t: 'error' }> | undefined;
const scopeOf = (sessionId: string): SessionScope => scopes.get(sessionId)!;

test('turn prompt includes the ranked shortlist and keeps an explicit reference pinned', async () => {
  const request = {
    sessionId: 's', turnId: 'prompt', mode: 'agent',
    instruction: 'find the new user token alpha theta login flow',
    references: [{ kind: 'file', path: FILE }],
    semanticSearch: true,
  } as TurnRequest;
  let semanticCalls = 0;
  let markSemanticFinished!: () => void;
  const semanticFinished = new Promise<void>((resolve) => { markSemanticFinished = resolve; });
  const progress: number[] = [];
  const options: ContextAssemblyOptions = {
    onSemanticProgress: (event) => { if (typeof event.progress === 'number') progress.push(event.progress); },
    semanticRanker: {
      rank: async (_query, chunks, _signal, onProgress) => {
        semanticCalls++;
        onProgress?.({ status: 'progress_total', progress: 42 });
        markSemanticFinished();
        return new Map(chunks.map((chunk) => [`${chunk.path}:${chunk.startLine}:${chunk.endLine}`, 0.95]));
      },
    },
  };
  const turnInput = await buildTurnInput(request, port, 2000, undefined, options);
  assert.ok(turnInput.input.includes('Context gathered by the editor'));
  assert.ok(turnInput.context?.text.includes(FILE));
  assert.ok(turnInput.context?.text.includes('@file'));
  assert.equal(turnInput.context?.report.selections[0]?.path, FILE);
  assert.equal(turnInput.context?.report.selections[0]?.source, 'explicit');
  await semanticFinished;
  assert.equal(semanticCalls, 1, 'the request setting reaches context assembly when keyword coverage is weak');
  assert.deepEqual(progress, [42], 'model progress reaches the active turn callback');
});

test('cancelling while semantic context is loading aborts the ranker', async () => {
  const request = {
    sessionId: 's', turnId: 'cancel-context', mode: 'agent',
    instruction: 'new user token alpha theta login', semanticSearch: true,
  } as TurnRequest;
  const controller = new AbortController();
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  let observedAbort = false;
  const options: ContextAssemblyOptions = {
    semanticRanker: {
      rank: async (_query, _chunks, signal) => new Promise((resolve) => {
        markStarted();
        signal?.addEventListener('abort', () => { observedAbort = true; resolve(new Map()); }, { once: true });
      }),
    },
  };
  const pending = buildTurnInput(request, port, 2000, controller.signal, options);
  await started;
  controller.abort();
  await pending;
  assert.ok(observedAbort);
});

test('coder and inline prompts use the ranked evidence workflow', async () => {
  const repoRoot = path.resolve(__dirname, '../../../../../../');
  const coder = JSON.parse(await fs.readFile(path.join(repoRoot, 'agent/forge-coder.json'), 'utf8')) as { manifest: { instructions: string } };
  const inline = JSON.parse(await fs.readFile(path.join(repoRoot, 'agent/forge-inline.json'), 'utf8')) as { manifest: { instructions: string } };
  // The coder prompt is p14's (kept over the hybrid branch's in the merge): explore / edit / verify with the
  // separate test-command budget enforced by the harness.
  assert.match(coder.manifest.instructions, /Work in three phases/);
  assert.match(coder.manifest.instructions, /context the editor ranked for this task/i);
  assert.match(coder.manifest.instructions, /exactly ONE propose_edit per file/i);
  assert.match(coder.manifest.instructions, /You have 2 run_command calls for the whole task/);
  assert.match(coder.manifest.instructions, /run only the test file\(s\) you changed or that cover the change/);
  assert.match(coder.manifest.instructions, /no cd, no pipes or redirection/);
  assert.match(coder.manifest.instructions, /read-only host filesystem/);
  assert.match(coder.manifest.instructions, /never use shell commands to edit source files/);
  assert.match(inline.manifest.instructions, /ranked context/i);
  assert.match(inline.manifest.instructions, /selected file only/i);
});

test('hybrid context reranking is opt-in and the request contract is versioned', async () => {
  const repoRoot = path.resolve(__dirname, '../../../../../../');
  const extension = JSON.parse(await fs.readFile(path.join(repoRoot, 'extension/package.json'), 'utf8')) as {
    contributes: { configuration: { properties: Record<string, { default?: unknown; description?: string }> } };
  };
  const setting = extension.contributes.configuration.properties['forge.context.semanticSearch'];
  assert.ok(setting, 'the semantic-search setting is declared');
  assert.equal(setting.default, false, 'semantic reranking is opt-in (confidence-gated and time-bounded when on)');
  assert.match(setting.description ?? '', /weak|200 ms/i);
  const mask = extension.contributes.configuration.properties['forge.context.maskSecrets'];
  assert.equal(mask?.default, true, 'credential masking of source sent to the model is on by default');
  assert.equal(PROTOCOL_VERSION as string, '0.4.8');
});

test('turn semantic setting is scoped to its session and stop aborts in-flight context work', async () => {
  const tf = new FakeTrueForge({ onTurn: (ch, k) => ch.push(ev('turn.created', { turnId: `rt-${k}` }), done('done')) });
  const run = makeRun(tf, {}, { semanticSearch: true });
  await run.start();
  const scope = scopeOf('rs-coder-1');
  assert.equal(scope.semanticSearch, true);
  const signal = scope.signal;
  scope.cancel();
  assert.equal(signal.aborted, true);
  scope.resetForTurn();
  assert.equal(scope.semanticSearch, false);
  assert.equal(scope.signal.aborted, false);
});

test('control: a model error before any approval is retried once', async () => {
  const tf = new FakeTrueForge({
    onTurn: (ch, k) => ch.push(ev('turn.created', { turnId: `rt-${k}` }), k === 1 ? done('error', '[Model Error] Request failed (503): overloaded') : done('done')),
  });
  const run = makeRun(tf);
  await run.start();
  assert.equal(tf.turns, 2, 'one retry');
  assert.equal(terminal(run).length, 1);
  assert.equal(terminal(run)[0]!.t === 'done' && terminal(run)[0]!.status, 'done');
});

test('B3: an approved edit still applying when the attempt fails blocks retry and fallback (apply outlasts the settle limit)', async () => {
  port.applyDelayMs = 600; // settleMs is 200
  let late: Promise<unknown> | undefined;
  const tf = new FakeTrueForge({
    onTurn: (ch) => ch.push(...toolCallNeedingApproval('c1', 'propose_edit', editArgs())),
    onApproval: (sub, sessionId) => {
      // TrueForge starts the approved tool call, then the model call after it fails while the apply is in flight.
      const scope = scopeOf(sessionId);
      late = scope.track(proposeEditTool({ port, scope }, editArgs()));
      sub.push(done('error', '[Model Error] Request failed (500): upstream exploded'));
    },
  });
  const run = makeRun(tf);
  void clickThrough(run);
  await run.start();
  assert.equal(tf.turns, 1, 'no second attempt while the write was in flight');
  assert.deepEqual(sessionsCreated, ['rs-coder-1'], 'no fallback session');
  assert.ok(!events(run).some((e) => e.t === 'fallback' || (e.t === 'status' && e.state === 'retrying')));
  const err = lastError(run);
  assert.equal(err?.error.workspaceEffect, 'unknown');
  assert.match(err!.error.message, /no retry or fallback/);
  assert.ok(events(run).some((e) => e.t === 'status' && /still running/.test(e.detail ?? '')), 'the unsettled call is reported');
  assert.equal(terminal(run).length, 1);
  await late;
  assert.equal(await fs.readFile(path.join(root, FILE), 'utf8'), 'def alpha():\n    return 10\n', 'the approved write itself still completes');
});

test('B3: an approved edit that TrueForge never executed blocks retry/fallback, and its approval can no longer be used', async () => {
  let failedSession = '';
  const tf = new FakeTrueForge({
    onTurn: (ch) => ch.push(...toolCallNeedingApproval('c1', 'propose_edit', editArgs())),
    onApproval: (sub, sessionId) => { failedSession = sessionId; sub.push(done('error', '[Model Error] Request failed (503): overloaded')); },
  });
  const run = makeRun(tf);
  void clickThrough(run);
  await run.start();
  assert.equal(tf.turns, 1, 'no retry');
  assert.deepEqual(sessionsCreated, ['rs-coder-1'], 'no fallback');
  assert.match(lastError(run)!.error.message, /approved change from this attempt had not finished/);
  // A late call for the approved edit is refused: the gate is closed.
  const scope = scopeOf(failedSession);
  const r = await proposeEditTool({ port, scope }, editArgs());
  assert.equal(r.ok, false);
  assert.equal(await fs.readFile(path.join(root, FILE), 'utf8'), ORIGINAL);
});

test('B2 at turn level: approve a command, TrueForge starts it, Stop lands before spawn → nothing runs', async () => {
  const cmd = { command: 'printf EXECUTED_AFTER_CANCEL > ran.txt' };
  let result: Awaited<ReturnType<typeof runCommandTool>> | undefined;
  let run!: TurnRun;
  const tf = new FakeTrueForge({
    onTurn: (ch) => ch.push(...toolCallNeedingApproval('c1', 'run_command', cmd)),
    onApproval: (sub, sessionId) => {
      const scope = scopeOf(sessionId);
      // The MCP call has passed the approval check and is preparing; the user presses Stop now.
      const call = scope.track(runCommandTool({ port, scope }, cmd));
      void run.cancel();
      void call.then((r) => { result = r; sub.push(done('cancelled')); });
    },
  });
  run = makeRun(tf);
  void clickThrough(run);
  await run.start();
  assert.ok(result, 'the tool call finished before the turn ended');
  assert.equal(!result.ok && result.code, 'CANCELLED');
  await assert.rejects(fs.access(path.join(root, 'ran.txt')), 'the command never ran');
  assert.equal(terminal(run).length, 1);
  assert.equal(terminal(run)[0]!.t === 'done' && terminal(run)[0]!.status, 'cancelled');
});

test('unlisted commands are flagged unrestricted in the approval request; listed ones are not', async () => {
  const flagged: Array<boolean | undefined> = [];
  for (const command of ['rm -rf build', 'python -m pytest -q']) {
    const tf = new FakeTrueForge({
      onTurn: (ch) => ch.push(...toolCallNeedingApproval('c1', 'run_command', { command })),
      onApproval: (sub) => sub.push(done('done')),
    });
    const run = makeRun(tf);
    void clickThrough(run);
    await run.start();
    const req = events(run).find((e) => e.t === 'command_request') as Extract<HarnessEvent, { t: 'command_request' }>;
    flagged.push(req.unrestricted);
    if (req.unrestricted) assert.match(req.warning ?? '', /not on the verification list.*write-protected/);
  }
  assert.deepEqual(flagged, [true, undefined]);
});

test('Stop against a silent TrueForge (stream and cancel never answer) ends the turn once, within the bound', async () => {
  const tf = new FakeTrueForge({
    onTurn: (ch) => ch.push(ev('turn.created', { turnId: 'rt-1' })), // then silence
    onCancel: () => new Promise(() => undefined), // the cancel request never returns
  });
  const run = makeRun(tf);
  const started = run.start();
  await new Promise((r) => setTimeout(r, 50));
  const t0 = Date.now();
  const status = await run.cancel();
  assert.equal(status, 'unconfirmed');
  await started;
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 150 * 2 + 200 + 1000, `ended in ${elapsed} ms`);
  assert.equal(terminal(run).length, 1);
  assert.equal(terminal(run)[0]!.t === 'done' && terminal(run)[0]!.status, 'cancelled');
  assert.ok(events(run).some((e) => e.t === 'status' && /did not confirm/.test(e.detail ?? '')));
});

test('watchdog against a silent TrueForge: retry and fallback run in new sessions and the turn ends with one error', async () => {
  const tf = new FakeTrueForge({
    onTurn: (ch, k) => ch.push(ev('turn.created', { turnId: `rt-${k}` })),
    onCancel: () => new Promise(() => undefined),
  });
  const run = makeRun(tf, { watchdogMs: 100 });
  const t0 = Date.now();
  await run.start();
  assert.ok(Date.now() - t0 < 5000, 'bounded');
  assert.equal(tf.turns, 3, 'attempt, retry, fallback');
  assert.equal(new Set(sessionsCreated).size, 3, 'an unconfirmed turn is never reused');
  assert.equal(terminal(run).length, 1);
  assert.equal(terminal(run)[0]!.t === 'done' && terminal(run)[0]!.status, 'error');
});

test('the watchdog does not fire while one of our tools is running (e.g. a long test run)', async () => {
  const cmd = { command: 'sleep 0.5' };
  const tf = new FakeTrueForge({
    onTurn: (ch) => ch.push(...toolCallNeedingApproval('c1', 'run_command', cmd)),
    onApproval: (sub, sessionId) => {
      const scope = scopeOf(sessionId);
      void scope.track(runCommandTool({ port, scope }, cmd)).then(() => sub.push(done('done')));
    },
  });
  const run = makeRun(tf, { watchdogMs: 100 });
  void clickThrough(run);
  await run.start();
  assert.equal(tf.cancels, 0, 'no watchdog cancel');
  assert.equal(terminal(run)[0]!.t === 'done' && terminal(run)[0]!.status, 'done');
});

test('an invalid key reported as HTTP 400 (Google style) falls back without a retry', async () => {
  const tf = new FakeTrueForge({
    onTurn: (ch, k) => ch.push(ev('turn.created', { turnId: `rt-${k}` }), k === 1 ? done('error', '[Model Error] Request failed (400): API key not valid. Please pass a valid API key.') : done('done')),
  });
  const run = makeRun(tf);
  await run.start();
  assert.equal(tf.turns, 2);
  assert.deepEqual(sessionsCreated, ['rs-coder-1', 'rs-coder-fallback-2']);
  assert.ok(events(run).some((e) => e.t === 'fallback'));
  assert.equal(terminal(run)[0]!.t === 'done' && terminal(run)[0]!.status, 'done');
});

/** Reads events and answers only what the user is asked; records what was asked. */
async function userAnswers(run: TurnRun, asked: HarnessEvent[]): Promise<void> {
  for await (const e of run.buffer.read(0)) {
    if (e.t === 'command_request' && !e.autoApproved) {
      asked.push(e);
      assert.deepEqual(run.submitReview({ kind: 'command', sessionId: e.sessionId, turnId: e.turnId, callId: e.callId, allow: true }), { ok: true });
    } else if (e.t === 'review_request') {
      asked.push(e);
      const p = e.proposal;
      assert.deepEqual(run.submitReview({ kind: 'edit', sessionId: p.sessionId, turnId: p.turnId, callId: p.callId, proposalId: p.proposalId, hunks: Object.fromEntries(p.hunks.map((h) => [h.hunkId, 'accept'])) }), { ok: true });
    }
  }
}

test('autoApproveSafeCommands: a listed command runs without a prompt and is reported as auto-approved', { skip: process.platform === 'win32' && 'readonly command sandbox requires Linux' }, async () => {
  const cmd = { command: 'git status --short' };
  let result: Awaited<ReturnType<typeof runCommandTool>> | undefined;
  const tf = new FakeTrueForge({
    onTurn: (ch) => ch.push(...toolCallNeedingApproval('c1', 'run_command', cmd)),
    onApproval: (sub, sessionId) => {
      // TrueForge runs the approved call: the MCP tool must find the recorded one-use approval.
      void runCommandTool({ port, scope: scopeOf(sessionId) }, cmd).then((r) => { result = r; sub.push(done('done')); });
    },
  });
  const run = makeRun(tf, {}, { autoApproveSafeCommands: true });
  const asked: HarnessEvent[] = [];
  void userAnswers(run, asked);
  await run.start();
  assert.equal(asked.length, 0, 'the user was not asked');
  const req = events(run).find((e) => e.t === 'command_request') as Extract<HarnessEvent, { t: 'command_request' }>;
  assert.equal(req.autoApproved, true, 'shown to the user as auto-approved');
  assert.equal(req.unrestricted, undefined);
  assert.equal(req.command, 'git status --short');
  assert.ok(result?.ok, 'the command ran with the auto-approval');
  assert.equal(terminal(run)[0]!.t === 'done' && terminal(run)[0]!.status, 'done');
});

test('autoApproveSafeCommands never auto-approves unrestricted commands or edits', async () => {
  for (const [tool, args] of [
    ['run_command', { command: 'python -m pytest tests | tail -5' }],
    ['run_command', { command: 'rm -rf build' }],
    ['run_command', { command: 'python -m pytest -q && rm -rf build' }],
    ['propose_edit', editArgs()],
  ] as const) {
    const tf = new FakeTrueForge({
      onTurn: (ch) => ch.push(...toolCallNeedingApproval('c1', tool, args)),
      onApproval: (sub) => sub.push(done('done')),
    });
    const run = makeRun(tf, {}, { autoApproveSafeCommands: true });
    const asked: HarnessEvent[] = [];
    void userAnswers(run, asked);
    await run.start();
    assert.equal(asked.length, 1, `${tool} ${JSON.stringify(args)} waited for the user`);
    const e = asked[0]!;
    if (e.t === 'command_request') {
      assert.equal(e.unrestricted, true);
      assert.equal(e.autoApproved, undefined);
    } else assert.equal(e.t, 'review_request');
    assert.equal(events(run).some((x) => x.t === 'command_request' && x.autoApproved), false);
  }
});

test('auto-approval is off unless the request sets autoApproveSafeCommands to true', async () => {
  for (const request of [{}, { autoApproveSafeCommands: false }, { autoApproveSafeCommands: 'true' }]) {
    const tf = new FakeTrueForge({
      onTurn: (ch) => ch.push(...toolCallNeedingApproval('c1', 'run_command', { command: 'python -m pytest -q' })),
      onApproval: (sub) => sub.push(done('done')),
    });
    const run = makeRun(tf, {}, request);
    const asked: HarnessEvent[] = [];
    void userAnswers(run, asked);
    await run.start();
    assert.equal(asked.length, 1, `prompted with ${JSON.stringify(request)}`);
  }
});

test('a propose_edit whose edits arrive as a JSON string is reviewed and applied (not refused as "0 edits")', async () => {
  const args = { ...editArgs(), edits: JSON.stringify(editArgs().edits) };
  let result: Awaited<ReturnType<typeof proposeEditTool>> | undefined;
  const tf = new FakeTrueForge({
    onTurn: (ch) => ch.push(...toolCallNeedingApproval('c1', 'propose_edit', args)),
    onApproval: (sub, sessionId) => {
      // The MCP server's schema hands the tool the parsed array; the approval was recorded from the string.
      void proposeEditTool({ port, scope: scopeOf(sessionId) }, editArgs()).then((r) => { result = r; sub.push(done('done')); });
    },
  });
  const run = makeRun(tf);
  void clickThrough(run);
  await run.start();
  const call = events(run).find((e) => e.t === 'tool_call') as Extract<HarnessEvent, { t: 'tool_call' }>;
  assert.match(call.summary, /\(1 edit\)/, 'the panel summary counts the edits');
  const review = events(run).find((e) => e.t === 'review_request') as Extract<HarnessEvent, { t: 'review_request' }>;
  assert.equal(review.proposal.hunks.length, 1);
  assert.ok(result?.ok, 'applied with the recorded approval');
  assert.equal(await fs.readFile(path.join(root, FILE), 'utf8'), 'def alpha():\n    return 10\n');
});

/** A model that makes the given tool calls one per step, each paused for approval, then finishes. */
function stepwise(calls: Array<[string, unknown]>): FakeTrueForge {
  let next = 0;
  const pause = (ch: Channel) => {
    const [tool, args] = calls[next]!;
    const id = `c${++next}`;
    const step = toolCallNeedingApproval(id, tool, args);
    ch.push(...(next === 1 ? step : step.slice(1)));
  };
  return new FakeTrueForge({
    onTurn: (ch) => pause(ch),
    onApproval: (sub) => (next < calls.length ? pause(sub) : sub.push(done('done'))),
  });
}

/** Answers prompts like userAnswers, but denies commands. */
async function userDeniesCommands(run: TurnRun, asked: HarnessEvent[]): Promise<void> {
  for await (const e of run.buffer.read(0)) {
    if (e.t === 'command_request' && !e.autoApproved) {
      asked.push(e);
      run.submitReview({ kind: 'command', sessionId: e.sessionId, turnId: e.turnId, callId: e.callId, allow: false });
    }
  }
}

test('command budget: after 3 non-test commands in an agent turn, run_command is refused without asking', async () => {
  const commands = ['git status', 'flask routes', 'python -c "import flask"', 'git diff', 'ls'];
  const tf = stepwise(commands.map((command) => ['run_command', { command }]));
  const run = makeRun(tf, {}, { commandBudget: 3 });
  const asked: HarnessEvent[] = [];
  void userAnswers(run, asked);
  await run.start();
  assert.deepEqual(asked.map((e) => e.t === 'command_request' && e.command), commands.slice(0, 3), 'only the first 3 were shown');
  const reached = events(run).filter((e) => e.t === 'command_budget_reached') as Array<Extract<HarnessEvent, { t: 'command_budget_reached' }>>;
  assert.deepEqual(reached.map((e) => [e.command, e.budget, e.kind]), [['git diff', 3, 'other'], ['ls', 3, 'other']]);
  assert.deepEqual(tf.approvals.map((a) => a.approval.status), ['allow', 'allow', 'allow', 'deny', 'deny']);
  for (const a of tf.approvals.slice(3)) assert.match(a.approval.reason ?? '', new RegExp(COMMAND_BUDGET_EXHAUSTED));
  assert.equal(terminal(run)[0]!.t === 'done' && terminal(run)[0]!.status, 'done');
});

test('test-command budget: test runs have their own budget (3 for agent); other commands are counted separately', async () => {
  const commands = ['python -m pytest tests/a.py', 'git diff', 'pytest -q', 'flask routes', '.venv/bin/pytest tests/a.py', 'pytest tests/b.py', 'ls'];
  const tf = stepwise(commands.map((command) => ['run_command', { command }]));
  const run = makeRun(tf);
  const asked: HarnessEvent[] = [];
  void userAnswers(run, asked);
  await run.start();
  assert.deepEqual(asked.map((e) => e.t === 'command_request' && e.command),
    ['python -m pytest tests/a.py', 'git diff', 'pytest -q', 'flask routes', '.venv/bin/pytest tests/a.py', 'ls'], 'the 4th test run was not shown');
  const reached = events(run).filter((e) => e.t === 'command_budget_reached') as Array<Extract<HarnessEvent, { t: 'command_budget_reached' }>>;
  assert.deepEqual(reached.map((e) => [e.command, e.budget, e.kind]), [['pytest tests/b.py', 3, 'test']]);
  assert.match(tf.approvals[5]!.approval.reason ?? '', /^TEST_BUDGET_EXHAUSTED: /);
  assert.match(tf.approvals[5]!.approval.reason ?? '', new RegExp(TEST_BUDGET_EXHAUSTED));
});

test('test-command budget: a denied debug command does not use up a test rerun (the phase 1b B1 sequence)', async () => {
  // pytest fails, fix, pytest fails again, a denied debug command, then the third test run still runs.
  const tf = stepwise([['run_command', { command: 'python -m pytest tests/a.py -q' }], ['run_command', { command: 'python -m pytest tests/a.py -q -x' }],
    ['run_command', { command: 'python -c "import sys; print(sys.path)" | head' }], ['run_command', { command: 'python -m pytest tests/a.py -q -k config' }]]);
  const run = makeRun(tf);
  const asked: HarnessEvent[] = [];
  void userDeniesCommands(run, asked);
  await run.start();
  assert.equal(asked.length, 4, 'all four were shown');
  assert.equal(events(run).filter((e) => e.t === 'command_budget_reached').length, 0);
});

test('command budget: denied and unrestricted commands count; auto-approved ones count too', async () => {
  // Denied by the user: still used the budget (the user was asked).
  let tf = stepwise([['run_command', { command: 'rm -rf build' }], ['run_command', { command: 'git status' }]]);
  let run = makeRun(tf, {}, { commandBudget: 1 });
  const asked: HarnessEvent[] = [];
  void userDeniesCommands(run, asked);
  await run.start();
  assert.equal(asked.length, 1);
  assert.deepEqual(tf.approvals.map((a) => a.approval.status), ['deny', 'deny']);
  assert.match(tf.approvals[1]!.approval.reason ?? '', /COMMAND_BUDGET_EXHAUSTED/);

  // Auto-approved: counted as well, so auto-approval cannot exceed the budget (other commands and test runs alike).
  tf = stepwise([['run_command', { command: 'git status' }], ['run_command', { command: 'git diff' }], ['run_command', { command: 'pytest' }], ['run_command', { command: 'pytest -q' }]]);
  run = makeRun(tf, {}, { commandBudget: 1, testCommandBudget: 1, autoApproveSafeCommands: true });
  void userAnswers(run, []);
  await run.start();
  assert.deepEqual(tf.approvals.map((a) => a.approval.status), ['allow', 'deny', 'allow', 'deny']);
  assert.deepEqual((events(run).filter((e) => e.t === 'command_budget_reached') as Array<Extract<HarnessEvent, { t: 'command_budget_reached' }>>).map((e) => e.kind), ['other', 'test']);
});

test('command budgets: 0 and 0 refuse every command; edits are never limited', async () => {
  const tf = stepwise([['run_command', { command: 'pytest' }], ['run_command', { command: 'git status' }], ['propose_edit', editArgs()]]);
  const run = makeRun(tf, {}, { commandBudget: 0, testCommandBudget: 0 });
  const asked: HarnessEvent[] = [];
  void userAnswers(run, asked);
  await run.start();
  assert.deepEqual(asked.map((e) => e.t), ['review_request'], 'the edit was still reviewed; the commands never asked');
  assert.deepEqual(tf.approvals.map((a) => a.approval.status), ['deny', 'deny', 'allow']);
});

test('command budget defaults: 3 for agent, 1 for inline (both budgets); invalid values use the default', () => {
  assert.equal(commandBudgetOf({ mode: 'agent' }), 3);
  assert.equal(commandBudgetOf({ mode: 'inline' }), 1);
  assert.equal(commandBudgetOf({ mode: 'agent', commandBudget: 0 }), 0);
  assert.equal(commandBudgetOf({ mode: 'inline', commandBudget: 5 }), 5);
  for (const bad of [-1, 1.5, Number.NaN]) assert.equal(commandBudgetOf({ mode: 'agent', commandBudget: bad }), 3);
  assert.equal(testCommandBudgetOf({ mode: 'agent' }), 3);
  assert.equal(testCommandBudgetOf({ mode: 'inline' }), 1);
  assert.equal(testCommandBudgetOf({ mode: 'agent', testCommandBudget: 0 }), 0);
  for (const bad of [-1, 2.5, Number.NaN]) assert.equal(testCommandBudgetOf({ mode: 'inline', testCommandBudget: bad }), 1);
});

/** An approved edit is applied through the MCP tool, then TrueForge ends the turn with `message`. */
function editThenError(message: string): FakeTrueForge {
  return new FakeTrueForge({
    onTurn: (ch) => ch.push(...toolCallNeedingApproval('c1', 'propose_edit', editArgs())),
    onApproval: (sub, sessionId) => {
      void proposeEditTool({ port, scope: scopeOf(sessionId) }, editArgs()).then(() => sub.push(done('error', message)));
    },
  });
}

test('resume: a rate limit after an applied edit emits resumable (changed files, wait) before the error; no retry or fallback', async () => {
  const tf = editThenError('[Model Error] Request failed (429): Too Many Requests');
  const run = makeRun(tf);
  void clickThrough(run);
  await run.start();
  assert.equal(tf.turns, 1, 'no retry or fallback after a write');
  const kinds = events(run).map((e) => e.t);
  assert.ok(kinds.indexOf('resumable') >= 0 && kinds.indexOf('resumable') < kinds.indexOf('error'), 'resumable comes before the error');
  const r = events(run).find((e) => e.t === 'resumable') as Extract<HarnessEvent, { t: 'resumable' }>;
  assert.deepEqual([r.reason, r.changedFiles], ['rate_limited', [FILE]]);
  assert.ok(r.retryAfterMs >= RESUME_WAIT_MS);
  assert.equal(lastError(run)!.error.workspaceEffect, 'changed');
  assert.deepEqual(run.resumable, { turnId: run.req.turnId, reason: 'rate_limited', changedFiles: [FILE], commandsUsed: 0, testsUsed: 0, ...stoppedIn(run) });
  run.markResumed('t-next');
  assert.equal(run.resumable, undefined, 'a turn is resumed once');
});

/** The agent and TrueForge session a turn last ran in (its last `session` event): what a Resume of it continues. */
function stoppedIn(run: TurnRun): { agentName: string; runtimeSessionId: string } {
  const s = events(run).filter((e) => e.t === 'session').at(-1) as Extract<HarnessEvent, { t: 'session' }>;
  return { agentName: s.agentName, runtimeSessionId: s.runtimeSessionId };
}

test('resume after a fallback: a write on the fallback then a 429 is resumable in the fallback session, and Resume continues there', async () => {
  // Turn 1 (primary session): 401 before any write → fallback. Turn 2 (fallback session): edit, then 429.
  const tf = new FakeTrueForge({
    onTurn: (ch, turn) => {
      if (turn === 1) ch.push(ev('turn.created', { turnId: 'rt-1' }), done('error', '[Model Error] Request failed (401): Unauthorized'));
      else ch.push(...toolCallNeedingApproval('c1', 'propose_edit', editArgs()));
    },
    onApproval: (sub, sessionId) => {
      void proposeEditTool({ port, scope: scopeOf(sessionId) }, editArgs()).then(() => sub.push(done('error', '[Model Error] Request failed (429): Too Many Requests')));
    },
  });
  const run = makeRun(tf);
  void clickThrough(run);
  await run.start();
  assert.equal(events(run).filter((e) => e.t === 'fallback').length, 1);
  const sessions = events(run).filter((e) => e.t === 'session') as Array<Extract<HarnessEvent, { t: 'session' }>>;
  assert.deepEqual(sessions.map((e) => e.agentName), ['coder', 'coder-fallback']);
  const fallbackSession = sessions[1]!.runtimeSessionId;
  assert.deepEqual(run.resumable, { turnId: run.req.turnId, reason: 'rate_limited', changedFiles: [FILE], commandsUsed: 0, testsUsed: 0, agentName: 'coder-fallback', runtimeSessionId: fallbackSession });

  // Resume: a new turn whose runtimeSession would hand out the primary's session; it must not be asked.
  const tf2 = new FakeTrueForge({ onTurn: (ch) => ch.push(ev('turn.created', { turnId: 'rt-9' }), done('done')) });
  const asked: string[] = [];
  const resumed = makeRun(tf2, { resumeFrom: run.resumable, runtimeSession: async (agent) => { asked.push(agent); return 'rs-primary-again'; } });
  await resumed.start();
  assert.deepEqual(asked, [], 'no new or primary session is opened');
  const s2 = events(resumed).filter((e) => e.t === 'session') as Array<Extract<HarnessEvent, { t: 'session' }>>;
  assert.deepEqual(s2.map((e) => [e.agentName, e.runtimeSessionId]), [['coder-fallback', fallbackSession]]);
  assert.ok(events(resumed).some((e) => e.t === 'status' && /Resuming the turn that stopped on a rate limit \(1 file already changed\) on the fallback model/.test(e.detail ?? '')));
  assert.equal(events(resumed).filter((e) => e.t === 'fallback').length, 0);
  assert.equal(events(resumed).at(-1)?.t, 'done');
  assert.ok(tf2.inputs[0]!.startsWith('Resumed turn:'));
});

test('resume: the write barrier covers the resumed turn: an error before its own first write is not retried and does not fall back', async () => {
  for (const [message, resumable] of [['[Model Error] Request failed (500): upstream exploded', false], ['[Model Error] Request failed (429): Too Many Requests', true]] as const) {
    const tf = new FakeTrueForge({ onTurn: (ch) => ch.push(ev('turn.created', { turnId: 'rt-1' }), done('error', message)) });
    const run = makeRun(tf, { resumeFrom: { turnId: 't-before', reason: 'rate_limited', changedFiles: [FILE], commandsUsed: 0, testsUsed: 0 } });
    await run.start();
    const evs = events(run);
    assert.equal(tf.inputs.length, 1, `${message}: one attempt only (no retry)`);
    assert.equal(evs.filter((e) => e.t === 'fallback').length, 0, `${message}: no fallback`);
    const err = evs.find((e) => e.t === 'error') as Extract<HarnessEvent, { t: 'error' }>;
    assert.match(err.error.message, /the interrupted turn this one resumes already changed the workspace/);
    assert.equal(err.error.workspaceEffect, 'changed');
    assert.equal(err.error.retryable, false);
    assert.equal(evs.some((e) => e.t === 'resumable'), resumable, `${message}: Resume offered again only for a rate limit`);
    if (resumable) assert.deepEqual(run.resumable?.changedFiles, [FILE]);
  }
});

test('the turn input is masked: a credential shape in the request or context never reaches TrueForge; off when disabled', async () => {
  const key = 'gsk_' + 'M'.repeat(40);
  const tf = new FakeTrueForge({ onTurn: (ch) => ch.push(ev('turn.created', { turnId: 'rt-1' }), done('done')) });
  const run = makeRun(tf, {}, { instruction: `use the key ${key} in alpha` });
  await run.start();
  assert.ok(!tf.inputs[0]!.includes(key));
  assert.match(tf.inputs[0]!, /use the key \[REDACTED\] in alpha/);
  assert.match(tf.inputs[0]!, /\[Forge masked 1 credential-shaped string in this text; the file itself is unchanged\]/);
  assert.ok(events(run).some((e) => e.t === 'status' && e.detail === 'Masked 1 credential-shaped string in the context sent to the model'));
  const tf2 = new FakeTrueForge({ onTurn: (ch) => ch.push(ev('turn.created', { turnId: 'rt-2' }), done('done')) });
  await makeRun(tf2, { maskSourceSecrets: false }, { instruction: `use the key ${key} in alpha` }).start();
  assert.ok(tf2.inputs[0]!.includes(key), 'maskSourceSecrets: false sends the text unchanged');
});

test('resume: no resumable event for failures that are not rate limits', async () => {
  for (const message of ['[Model Error] Request failed (401): Unauthorized', '[Model Error] Request failed (503): overloaded', 'iteration limit reached']) {
    const run = makeRun(editThenError(message));
    void clickThrough(run);
    await run.start();
    assert.equal(events(run).some((e) => e.t === 'resumable'), false, message);
    assert.equal(run.resumable, undefined);
  }
});

test('resume: the resumed turn opens with the resume note and the original request, and inherits the command usage', async () => {
  const tf = stepwise([['run_command', { command: 'git status' }], ['run_command', { command: 'pytest tests/a.py' }]]);
  const run = makeRun(tf, { resumeFrom: { turnId: 't-before', changedFiles: [FILE, 'docs/x.rst'], commandsUsed: 3, testsUsed: 1 } });
  const asked: HarnessEvent[] = [];
  void userAnswers(run, asked);
  await run.start();
  assert.match(tf.inputs[0]!, /^Resumed turn: your previous turn on this task stopped early because the model provider rate-limited requests \(HTTP 429\)\./);
  assert.match(tf.inputs[0]!, /Already changed in that turn: src\/app\.py, docs\/x\.rst\./);
  assert.match(tf.inputs[0]!, /Original request:\nchange alpha/);
  assert.deepEqual(asked.map((e) => e.t === 'command_request' && e.command), ['pytest tests/a.py'], 'the other-command budget was used up before the resume');
  assert.ok(events(run).some((e) => e.t === 'status' && /^Resuming the turn that stopped on a rate limit \(2 files already changed\)/.test(e.detail ?? '')));
});

test('resume: a resumed turn that is rate limited again lists the files of both turns', async () => {
  const run = makeRun(editThenError('[Model Error] Request failed (429): Too Many Requests'), { resumeFrom: { turnId: 't-before', changedFiles: ['docs/x.rst'], commandsUsed: 1, testsUsed: 2 } });
  void clickThrough(run);
  await run.start();
  const r = events(run).find((e) => e.t === 'resumable') as Extract<HarnessEvent, { t: 'resumable' }>;
  assert.deepEqual(r.changedFiles, ['docs/x.rst', FILE]);
  assert.deepEqual(run.resumable, { turnId: run.req.turnId, reason: 'rate_limited', changedFiles: ['docs/x.rst', FILE], commandsUsed: 1, testsUsed: 2, ...stoppedIn(run) });
});

test('watchdog: while a model request is in flight the longer limit applies; between steps the general one', async () => {
  // Model request in flight from turn.created: silent for 250 ms, then a reply. General limit 100 ms, model limit 1000 ms.
  const slowModel = new FakeTrueForge({
    // TrueForge's placeholder model.message at the request start does not end the request.
    onTurn: (ch) => { ch.push(ev('turn.created', { turnId: 'rt-1' }), ev('model.message', { model: 'm' })); setTimeout(() => ch.push(ev('model.message', { content: 'done' }), done('done')), 250); },
  });
  const ok = makeRun(slowModel, { watchdogMs: 100, modelWatchdogMs: 1000 });
  await ok.start();
  assert.equal(slowModel.cancels, 0, 'a slow generation is not a stall');
  assert.equal(terminal(ok)[0]!.t === 'done' && terminal(ok)[0]!.status, 'done');

  // After a complete model.message TrueForge is between steps: the general limit applies again.
  const silentAfter = new FakeTrueForge({
    onTurn: (ch, k) => ch.push(ev('turn.created', { turnId: `rt-${k}` }), ev('model.message', { content: 'thinking' })),
  });
  const stalled = makeRun(silentAfter, { watchdogMs: 100, modelWatchdogMs: 5000 });
  const t0 = Date.now();
  await stalled.start();
  assert.ok(Date.now() - t0 < 3000, 'the 100 ms limit fired, not the 5 s one');
  assert.ok(silentAfter.cancels >= 1);
  assert.match(lastError(stalled)!.error.message, /no response from the model for 0 s/);

  // A model request that stays silent past the model limit is a stall, and the message names that limit.
  const silentModel = new FakeTrueForge({ onTurn: (ch, k) => ch.push(ev('turn.created', { turnId: `rt-${k}` })) });
  const run = makeRun(silentModel, { watchdogMs: 50, modelWatchdogMs: 1000 });
  await run.start();
  assert.match(lastError(run)!.error.message, /no response from the model for 1 s/);
});

test('watchdog after an applied edit: the turn is resumable (reason stalled) instead of a dead end', async () => {
  const tf = new FakeTrueForge({
    onTurn: (ch) => ch.push(...toolCallNeedingApproval('c1', 'propose_edit', editArgs())),
    // The edit is applied, then TrueForge goes silent (the model is generating a long reply).
    onApproval: (sub, sessionId) => { void proposeEditTool({ port, scope: scopeOf(sessionId) }, editArgs()).then(() => sub.push(ev('tool.response', { toolCallId: 'c1', content: 'applied' }))); },
  });
  const run = makeRun(tf, { watchdogMs: 50, modelWatchdogMs: 200 });
  void clickThrough(run);
  await run.start();
  assert.equal(tf.turns, 1, 'no retry or fallback after a write');
  const r = events(run).find((e) => e.t === 'resumable') as Extract<HarnessEvent, { t: 'resumable' }>;
  assert.deepEqual([r.reason, r.changedFiles, r.retryAfterMs], ['stalled', [FILE], RESUME_AFTER_STALL_MS]);
  assert.match(lastError(run)!.error.message, /no response from the model for 0 s|no response from the model/);
  assert.deepEqual(run.resumable, { turnId: run.req.turnId, reason: 'stalled', changedFiles: [FILE], commandsUsed: 0, testsUsed: 0, ...stoppedIn(run) });

  const resumed = makeRun(new FakeTrueForge({ onTurn: (ch) => ch.push(ev('turn.created', { turnId: 'rt-9' }), done('done')) }), { resumeFrom: run.resumable });
  await resumed.start();
  assert.ok(events(resumed).some((e) => e.t === 'status' && /^Resuming the turn that stopped responding \(1 file already changed\)/.test(e.detail ?? '')));
});

test('a watchdog stop before any write is not resumable (retry and fallback handle it)', async () => {
  const tf = new FakeTrueForge({ onTurn: (ch, k) => ch.push(ev('turn.created', { turnId: `rt-${k}` })), onCancel: () => new Promise(() => undefined) });
  const run = makeRun(tf, { watchdogMs: 50, modelWatchdogMs: 50 });
  await run.start();
  assert.equal(events(run).some((e) => e.t === 'resumable'), false);
});

test('resume note after a stall says the model stopped responding', () => {
  assert.match(resumeNote({ changedFiles: [FILE], reason: 'stalled' }), /^Resumed turn: your previous turn on this task stopped early because the model stopped responding/);
});

test('done.tests reports the observed outcome of the last test command, whatever the model says', { skip: process.platform === 'win32' && 'needs a shell' }, async () => {
  // A fake "pytest" on PATH prints a pytest summary and exits 1.
  const bin = path.join(root, 'bin');
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(bin, 'pytest'), '#!/bin/sh\necho "F.."\necho "1 failed, 2 passed in 0.03s"\nexit 1\n', { mode: 0o755 });
  const oldPath = process.env['PATH'];
  process.env['PATH'] = `${bin}:${oldPath}`;
  try {
    const cmd = { command: 'pytest tests' };
    const tf = new FakeTrueForge({
      onTurn: (ch) => ch.push(...toolCallNeedingApproval('c1', 'run_command', cmd)),
      onApproval: (sub, sessionId) => { void runCommandTool({ port, scope: scopeOf(sessionId) }, cmd).then(() => sub.push(ev('model.message', { content: 'All tests pass.' }), done('done'))); },
    });
    const run = makeRun(tf);
    void clickThrough(run);
    await run.start();
    const d = terminal(run)[0] as Extract<HarnessEvent, { t: 'done' }>;
    assert.equal(d.status, 'done');
    assert.deepEqual(d.tests, { status: 'failed', command: 'pytest tests', exitCode: 1, passed: 2, failed: 1, summary: '1 failed, 2 passed in 0.03s' });
  } finally { process.env['PATH'] = oldPath; }

  const none = makeRun(new FakeTrueForge({ onTurn: (ch) => ch.push(ev('turn.created', { turnId: 'rt-1' }), done('done')) }));
  await none.start();
  assert.deepEqual((terminal(none)[0] as Extract<HarnessEvent, { t: 'done' }>).tests, { status: 'not_run' });
  const inline = makeRun(new FakeTrueForge({ onTurn: (ch) => ch.push(ev('turn.created', { turnId: 'rt-1' }), done('done')) }), {}, { mode: 'inline' });
  await inline.start();
  assert.equal((terminal(inline)[0] as Extract<HarnessEvent, { t: 'done' }>).tests, undefined, 'inline turns carry no test outcome');
});

test('done.tests marks the result stale when a file was saved after the last test command, and a later test run clears it', { skip: process.platform === 'win32' && 'needs a shell' }, async () => {
  const bin = path.join(root, 'bin');
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(bin, 'pytest'), '#!/bin/sh\necho "2 failed in 0.07s"\nexit 1\n', { mode: 0o755 });
  const oldPath = process.env['PATH'];
  process.env['PATH'] = `${bin}:${oldPath}`;
  // steps: test, edit (stale), [test again (fresh)]
  const scripted = (steps: Array<'test' | 'edit'>) => {
    let next = 0;
    const pause = (ch: Channel) => {
      const kind = steps[next]!; const id = `c${++next}`;
      const call = kind === 'test' ? toolCallNeedingApproval(id, 'run_command', { command: 'pytest tests' }) : toolCallNeedingApproval(id, 'propose_edit', editArgs());
      ch.push(...(next === 1 ? call : call.slice(1)));
    };
    return new FakeTrueForge({
      onTurn: (ch) => pause(ch),
      onApproval: (sub, sessionId) => {
        const kind = steps[next - 1]!;
        const scope = scopeOf(sessionId);
        const ran = kind === 'test' ? runCommandTool({ port, scope }, { command: 'pytest tests' }) : proposeEditTool({ port, scope }, editArgs());
        void ran.then(() => (next < steps.length ? pause(sub) : sub.push(ev('model.message', { content: 'All tests pass.' }), done('done'))));
      },
    });
  };
  try {
    const stale = makeRun(scripted(['test', 'edit']));
    void clickThrough(stale);
    await stale.start();
    const d = terminal(stale)[0] as Extract<HarnessEvent, { t: 'done' }>;
    assert.deepEqual([d.tests?.status, d.tests?.summary, d.tests?.editedAfter], ['failed', '2 failed in 0.07s', [FILE]]);

    await fs.writeFile(path.join(root, FILE), ORIGINAL);
    const fresh = makeRun(scripted(['edit', 'test']));
    void clickThrough(fresh);
    await fresh.start();
    const d2 = terminal(fresh)[0] as Extract<HarnessEvent, { t: 'done' }>;
    assert.equal(d2.tests?.status, 'failed');
    assert.equal(d2.tests?.editedAfter, undefined, 'edits before the test run do not make it stale');
  } finally { process.env['PATH'] = oldPath; }
});

test('review requests flag hunks that delete a whole function', async () => {
  const args = { path: FILE, base_sha256: sha256Hex(ORIGINAL), edits: [{ old_text: 'def alpha():\n    return 1\n', new_text: '' }] };
  const tf = new FakeTrueForge({ onTurn: (ch) => ch.push(...toolCallNeedingApproval('c1', 'propose_edit', args)), onApproval: (sub, sessionId) => {
    void proposeEditTool({ port, scope: scopeOf(sessionId) }, args).then(() => sub.push(done('done')));
  } });
  const run = makeRun(tf);
  void clickThrough(run);
  await run.start();
  const req = events(run).find((e) => e.t === 'review_request') as Extract<HarnessEvent, { t: 'review_request' }>;
  assert.deepEqual(req.proposal.hunks[0]!.deletes, [{ kind: 'function', name: 'alpha', lines: 2 }]);
});

test('sub-agents: delegation becomes subagent events and status lines; its edit is reviewed and approved on its own thread; its text is not the reply', async () => {
  let eventsSent = false;
  const child = ev('model.message', { threadId: 'th-sub', content: 'child notes', toolCalls: [{ id: 'cc1', function: { name: 'propose_edit', arguments: JSON.stringify(editArgs()) }, toolInfo: { type: 'mcp', name: 'propose_edit', serverName: 'vscode' } }] });
  const tf = new FakeTrueForge({
    onTurn: (ch) => ch.push(
      ev('turn.created', { turnId: 'rt-1' }),
      ev('model.message', { threadId: 'th-1', content: 'Delegating. ', toolCalls: [{ id: 'cs', function: { name: 'create_sub_agent', arguments: JSON.stringify({ name: 'explorer', input: 'Find where alpha is defined\nand tested' }) }, toolInfo: { type: 'truefoundry-system', name: 'create_sub_agent' } }] }),
      ev('thread.created', { threadId: 'th-sub', title: 'explorer', parent: { threadId: 'th-1', toolCallId: 'cs' }, agentInfo: { type: 'dynamic', name: 'explorer', input: 'Find where alpha is defined\nand tested' } }),
      child,
      ev('tool.approval_required', { threadId: 'th-sub', toolCalls: [{ id: 'cc1', sourceEventId: child.id }] }),
      ev('turn.update', { state: { status: 'paused' } }),
    ),
    onApproval: (sub, sessionId) => {
      if (eventsSent) return;
      eventsSent = true;
      void proposeEditTool({ port, scope: scopeOf(sessionId) }, editArgs()).then(() => sub.push(
        ev('thread.done', { threadId: 'th-sub', title: 'explorer', parent: { threadId: 'th-1', toolCallId: 'cs' }, state: { status: 'done', output: {} } }),
        ev('model.message', { threadId: 'th-1', content: 'All done.' }),
        done('done'),
      ));
    },
  });
  const run = makeRun(tf);
  void clickThrough(run);
  await run.start();
  const subs = events(run).filter((e) => e.t === 'subagent') as Array<Extract<HarnessEvent, { t: 'subagent' }>>;
  assert.deepEqual(subs.map((e) => [e.phase, e.name, e.threadId, e.task, e.ok]), [
    ['started', 'explorer', 'th-sub', 'Find where alpha is defined and tested', undefined],
    ['finished', 'explorer', 'th-sub', undefined, true],
  ]);
  const details = events(run).filter((e) => e.t === 'status' && e.detail).map((e) => (e as { detail: string }).detail);
  assert.ok(details.includes('Delegated to sub-agent "explorer": Find where alpha is defined and tested'));
  assert.ok(details.includes('Sub-agent "explorer" finished'));
  assert.equal(events(run).filter((e) => e.t === 'review_request').length, 1, "the sub-agent's edit was reviewed");
  assert.deepEqual(tf.approvals.map((a) => [a.toolCallId, a.threadId, a.approval.status]), [['cc1', 'th-sub', 'allow']]);
  const text = events(run).filter((e) => e.t === 'text').map((e) => (e as { delta: string }).delta).join('');
  assert.equal(text, 'Delegating. All done.');
  assert.equal(await fs.readFile(path.join(root, FILE), 'utf8'), 'def alpha():\n    return 10\n');
  const call = events(run).find((e) => e.t === 'tool_call' && e.displayName === 'create_sub_agent') as Extract<HarnessEvent, { t: 'tool_call' }>;
  assert.equal(call.tool, 'internal');
  assert.equal(call.summary, 'explorer: Find where alpha is defined and tested');
});

test('sub-agents: a failed sub-agent is reported with its error', async () => {
  const tf = new FakeTrueForge({
    onTurn: (ch) => ch.push(
      ev('turn.created', { turnId: 'rt-1' }),
      ev('thread.created', { threadId: 'th-sub', title: 'x', parent: { threadId: 'th-1', toolCallId: 'cs' }, agentInfo: { type: 'dynamic', name: 'scout', input: 'look' } }),
      ev('thread.done', { threadId: 'th-sub', title: 'x', parent: { threadId: 'th-1', toolCallId: 'cs' }, state: { status: 'error', error: '[Model Error] Request failed (429): slow down' } }),
      done('done'),
    ),
  });
  const run = makeRun(tf);
  await run.start();
  const fin = events(run).find((e) => e.t === 'subagent' && e.phase === 'finished') as Extract<HarnessEvent, { t: 'subagent' }>;
  assert.deepEqual([fin.ok, fin.error], [false, '[Model Error] Request failed (429): slow down']);
  assert.ok(events(run).some((e) => e.t === 'status' && e.detail === 'Sub-agent "scout" failed: [Model Error] Request failed (429): slow down'));
});

test('a cd-prefixed command is refused without a prompt and without using the budget, with the corrected call', async () => {
  const tf = stepwise([
    ['run_command', { command: 'cd /workspace && python -m pytest tests/test_cli.py -q' }],
    ['run_command', { command: 'cd examples/tutorial; flask --app flaskr --help' }],
    ['run_command', { command: 'python -m pytest tests/test_cli.py -q' }],
  ]);
  const run = makeRun(tf, {}, { commandBudget: 1 });
  const asked: HarnessEvent[] = [];
  void userAnswers(run, asked);
  await run.start();
  assert.deepEqual(asked.map((e) => e.t === 'command_request' && e.command), ['python -m pytest tests/test_cli.py -q'], 'only the bare command was shown');
  assert.deepEqual(tf.approvals.map((a) => a.approval.status), ['deny', 'deny', 'allow'], 'the budget of 1 was still free for the third call');
  assert.match(tf.approvals[0]!.approval.reason ?? '', /COMMAND_SHAPE: .*command "python -m pytest tests\/test_cli.py -q"\. Nothing was run and the command budget was not used/);
  assert.match(tf.approvals[1]!.approval.reason ?? '', /command "flask --app flaskr --help" and cwd "examples\/tutorial"/);
  assert.equal(events(run).filter((e) => e.t === 'command_budget_reached').length, 0);
});

test('cdPrefix: only a leading cd joined by && or ; is recognised', () => {
  assert.deepEqual(cdPrefix('cd /w && pytest -q'), { dir: '/w', rest: 'pytest -q' });
  assert.deepEqual(cdPrefix('  cd "a b";git status'), { dir: 'a b', rest: 'git status' });
  for (const c of ['pytest -q', 'echo cd x && y', 'cd x', 'cd x || y', 'cdx && y']) assert.equal(cdPrefix(c), undefined, c);
});

test('isTestCommand: pytest and python -m pytest only, without shell operators', () => {
  for (const c of ['python -m pytest tests/test_cli.py -q', 'pytest -q', '.venv/bin/python -m pytest', 'python3.12 -m pytest tests', 'FOO=1 pytest -x'])
    assert.equal(isTestCommand(c), true, c);
  for (const c of ['python -c "import pytest"', 'python -m pytest; rm -rf x', 'flask --help', 'git diff', 'pytest | tee log', 'python -m pytestx'])
    assert.equal(isTestCommand(c), false, c);
});

test('autoApproveSafeCommands is narrowed: python -c, flask and path- or env-prefixed pytest still ask (not as unrestricted)', async () => {
  for (const command of ['python -c "print(1)"', 'flask routes', '.venv/bin/pytest -q', 'PYTHONPATH=src pytest']) {
    const tf = stepwise([['run_command', { command }]]);
    const run = makeRun(tf, {}, { autoApproveSafeCommands: true });
    const asked: HarnessEvent[] = [];
    void userAnswers(run, asked);
    await run.start();
    assert.equal(asked.length, 1, `${command} asked`);
    const e = asked[0] as Extract<HarnessEvent, { t: 'command_request' }>;
    assert.equal(e.unrestricted, undefined, `${command} is listed, so no unrestricted warning`);
    assert.equal(e.autoApproved, undefined);
  }
  for (const command of ['pytest tests/test_cli.py -q', 'python3 -m pytest -q', 'git status --short', 'git diff']) {
    const tf = stepwise([['run_command', { command }]]);
    const run = makeRun(tf, {}, { autoApproveSafeCommands: true });
    const asked: HarnessEvent[] = [];
    void userAnswers(run, asked);
    await run.start();
    assert.equal(asked.length, 0, `${command} auto-approved`);
  }
});

test('a repeated argument-error refusal for the same file includes the expected argument shape', async () => {
  const bad = { ...editArgs(), edits: '[{"old_text": "def alpha' }; // a truncated JSON string
  const other = { ...bad, path: 'src/other.py', base_sha256: '' };
  const tf = stepwise([['propose_edit', bad], ['propose_edit', other], ['propose_edit', bad], ['propose_edit', bad]]);
  const run = makeRun(tf);
  void userAnswers(run, []);
  await run.start();
  const reasons = tf.approvals.map((a) => a.approval.reason ?? '');
  assert.equal(reasons.length, 4);
  assert.match(reasons[0]!, /^INVALID_EDIT/);
  assert.ok(!reasons[0]!.includes(PROPOSE_EDIT_SHAPE_HINT), 'first refusal: the error only');
  assert.ok(!reasons[1]!.includes(PROPOSE_EDIT_SHAPE_HINT), 'another file: its first refusal');
  assert.ok(reasons[2]!.includes(PROPOSE_EDIT_SHAPE_HINT), 'same file again: the shape is spelled out');
  assert.ok(reasons[3]!.includes(PROPOSE_EDIT_SHAPE_HINT));
  // The example in the hint is itself a valid propose_edit argument object.
  const h = PROPOSE_EDIT_SHAPE_HINT;
  const example = JSON.parse(h.slice(h.indexOf('{'), h.indexOf('}. ') + 1)) as { path: string; edits: unknown[] };
  assert.equal(typeof example.path, 'string');
  assert.ok(Array.isArray(example.edits) && example.edits.length === 1);
});

test('content refusals (old_text not found) do not trigger the shape hint', async () => {
  const missing = { ...editArgs(), edits: [{ old_text: 'not in the file', new_text: 'x' }] };
  const tf = stepwise([['propose_edit', missing], ['propose_edit', missing]]);
  const run = makeRun(tf);
  void userAnswers(run, []);
  await run.start();
  assert.equal(tf.approvals.length, 2);
  for (const a of tf.approvals) {
    assert.match(a.approval.reason ?? '', /^OLD_TEXT_NOT_FOUND/);
    assert.ok(!(a.approval.reason ?? '').includes(PROPOSE_EDIT_SHAPE_HINT));
  }
});

test('a dropped connection while creating the session is retried once; a second failure is reported as unreachable', async () => {
  const dropped = () => Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) });
  for (const failures of [1, 2]) {
    let calls = 0;
    const tf = new FakeTrueForge({ onTurn: (ch, k) => ch.push(ev('turn.created', { turnId: `rt-${k}` }), done('done')) });
    const run = makeRun(tf, {
      runtimeSession: async () => { calls++; if (calls <= failures) throw dropped(); return `rs-${calls}`; },
    });
    await run.start();
    await clickThrough(run);
    const end = terminal(run);
    assert.equal(end.length, 1, 'exactly one terminal event');
    assert.ok(events(run).some((e) => e.t === 'status' && e.state === 'retrying' && /ECONNRESET/.test(e.detail ?? '')), 'retry is visible with its cause');
    if (failures === 1) {
      assert.equal(calls, 2);
      assert.equal((end[0] as { status: string }).status, 'done');
    } else {
      assert.equal(calls, 2, 'retried once, not more');
      assert.equal((end[0] as { status: string }).status, 'error');
      assert.match(lastError(run)!.error.message, /TrueForge is not reachable/);
    }
  }
});

test('a non-network error creating the session is not retried', async () => {
  let calls = 0;
  const tf = new FakeTrueForge({ onTurn: (ch, k) => ch.push(ev('turn.created', { turnId: `rt-${k}` }), done('done')) });
  const run = makeRun(tf, { runtimeSession: async () => { calls++; throw Object.assign(new Error('Not Found'), { statusCode: 404 }); } });
  await run.start();
  await clickThrough(run);
  assert.equal(calls, 1);
  assert.match(lastError(run)!.error.message, /agent "coder" not found/);
});

test('a repeated review decision is accepted whatever its property order; a different one is a conflict', async () => {
  const tf = stepwise([['propose_edit', editArgs()]]);
  const run = makeRun(tf);
  const replies: unknown[] = [];
  const answering = (async () => {
    for await (const e of run.buffer.read(0)) {
      if (e.t !== 'review_request') continue;
      const p = e.proposal;
      const hunks = Object.fromEntries(p.hunks.map((h) => [h.hunkId, 'accept' as const]));
      replies.push(run.submitReview({ kind: 'edit', sessionId: p.sessionId, turnId: p.turnId, callId: p.callId, proposalId: p.proposalId, hunks }));
      // The same decision, keys in another order (as a retried message from the editor could arrive).
      replies.push(run.submitReview({ hunks, proposalId: p.proposalId, callId: p.callId, turnId: p.turnId, sessionId: p.sessionId, kind: 'edit' } as ReviewDecision));
      replies.push(run.submitReview({ kind: 'edit', sessionId: p.sessionId, turnId: p.turnId, callId: p.callId, proposalId: p.proposalId, hunks: Object.fromEntries(p.hunks.map((h) => [h.hunkId, 'reject' as const])) }));
    }
  })();
  await run.start();
  await answering;
  assert.deepEqual(replies[0], { ok: true });
  assert.deepEqual(replies[1], { ok: true }, 'reordered duplicate accepted');
  assert.equal((replies[2] as { error?: { code: string } }).error?.code, 'conflict');
});
