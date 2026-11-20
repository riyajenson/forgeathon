// TurnRun against an in-memory stand-in for the TrueForge client: deterministic races that a real server
// cannot reproduce on demand (late tool calls, silent servers, approvals that were never executed).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { HarnessEvent, ReviewDecision } from '../contract-types';
import { FakePort } from '../mcp/fake-port';
import { ScopeRegistry, type SessionScope } from '../mcp/scope';
import { proposeEditTool } from '../mcp/tools';
import { runCommandTool } from '../mcp/command';
import { sha256Hex } from '../review';
import type { TrueForgeClient, TrueForgeSdk } from '../trueforge/sdk';
import { COMMAND_BUDGET_EXHAUSTED, commandBudgetOf, PROPOSE_EDIT_SHAPE_HINT, TurnRun, type TurnDeps } from './turn';

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
  readonly approvals: Array<{ toolCallId: string; approval: { status: string; reason?: string } }> = [];
  private active: Channel | undefined;
  constructor(private readonly script: Script) {}

  readonly client = {
    sessions: {
      createTurnStream: async (sessionId: string, _req: unknown, opts?: { abortSignal?: AbortSignal }) => {
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
    ['run_command', { command: 'cd /workspace && python -m pytest -q' }],
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

test('command budget: after 3 commands in an agent turn, run_command is refused without asking', async () => {
  const commands = ['python -m pytest tests/a.py', 'git diff', 'flask routes', 'python -m pytest', 'ls'];
  const tf = stepwise(commands.map((command) => ['run_command', { command }]));
  const run = makeRun(tf);
  const asked: HarnessEvent[] = [];
  void userAnswers(run, asked);
  await run.start();
  assert.deepEqual(asked.map((e) => e.t === 'command_request' && e.command), commands.slice(0, 3), 'only the first 3 were shown');
  const reached = events(run).filter((e) => e.t === 'command_budget_reached') as Array<Extract<HarnessEvent, { t: 'command_budget_reached' }>>;
  assert.deepEqual(reached.map((e) => [e.command, e.budget]), [['python -m pytest', 3], ['ls', 3]]);
  assert.deepEqual(tf.approvals.map((a) => a.approval.status), ['allow', 'allow', 'allow', 'deny', 'deny']);
  for (const a of tf.approvals.slice(3)) assert.match(a.approval.reason ?? '', new RegExp(COMMAND_BUDGET_EXHAUSTED));
  assert.equal(terminal(run)[0]!.t === 'done' && terminal(run)[0]!.status, 'done');
});

test('command budget: denied and unrestricted commands count; auto-approved ones count too', async () => {
  // Denied by the user: still used the budget (the user was asked).
  let tf = stepwise([['run_command', { command: 'rm -rf build' }], ['run_command', { command: 'pytest' }]]);
  let run = makeRun(tf, {}, { commandBudget: 1 });
  const asked: HarnessEvent[] = [];
  void userDeniesCommands(run, asked);
  await run.start();
  assert.equal(asked.length, 1);
  assert.deepEqual(tf.approvals.map((a) => a.approval.status), ['deny', 'deny']);
  assert.match(tf.approvals[1]!.approval.reason ?? '', /COMMAND_BUDGET_EXHAUSTED/);

  // Auto-approved: counted as well, so auto-approval cannot exceed the budget.
  tf = stepwise([['run_command', { command: 'git status' }], ['run_command', { command: 'git diff' }]]);
  run = makeRun(tf, {}, { commandBudget: 1, autoApproveSafeCommands: true });
  void userAnswers(run, []);
  await run.start();
  assert.deepEqual(tf.approvals.map((a) => a.approval.status), ['allow', 'deny']);
  assert.equal(events(run).filter((e) => e.t === 'command_budget_reached').length, 1);
});

test('command budget: 0 refuses every command; edits are never limited', async () => {
  const tf = stepwise([['run_command', { command: 'pytest' }], ['propose_edit', editArgs()]]);
  const run = makeRun(tf, {}, { commandBudget: 0 });
  const asked: HarnessEvent[] = [];
  void userAnswers(run, asked);
  await run.start();
  assert.deepEqual(asked.map((e) => e.t), ['review_request'], 'the edit was still reviewed; the command never asked');
  assert.deepEqual(tf.approvals.map((a) => a.approval.status), ['deny', 'allow']);
});

test('command budget defaults: 3 for agent, 1 for inline; invalid values use the default', () => {
  assert.equal(commandBudgetOf({ mode: 'agent' }), 3);
  assert.equal(commandBudgetOf({ mode: 'inline' }), 1);
  assert.equal(commandBudgetOf({ mode: 'agent', commandBudget: 0 }), 0);
  assert.equal(commandBudgetOf({ mode: 'inline', commandBudget: 5 }), 5);
  for (const bad of [-1, 1.5, Number.NaN]) assert.equal(commandBudgetOf({ mode: 'agent', commandBudget: bad }), 3);
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
