// Integration tests against a real local TrueForge 0.185.1 (TF_URL, default http://127.0.0.1:8790) and the
// in-process mock model. TrueForge must be started with OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1"]'.
// Run with: npm run test:integration
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createHarness } from '../harness';
import { PROTOCOL_VERSION, type ForgeHarness, type HarnessEvent, type ReviewDecision } from '../contract-types';
import { FakePort } from '../mcp/fake-port';
import { sha256Hex } from '../review';
import { createClient } from '../trueforge/sdk';
import { MockModel, MOCK_KEY, scenarioOf, textOf, type MockReply, type MockRequest } from '../testing/mock-model';

const TF_URL = process.env['TF_URL'] ?? 'http://127.0.0.1:8790';
const MOCK_PORT = 47702;
const CONNECTOR = 'vscode-it';
const FILE = 'src/app.py';
const ORIGINAL = 'def alpha():\n    return 1\n\n\ndef beta():\n    return 2\n';

let root: string;
let port: FakePort;
const mock = new MockModel();
let seq = 0;
const rid = () => `req-${Date.now()}-${++seq}`;

const fileSha = async () => sha256Hex(await fs.readFile(path.join(root, FILE), 'utf8'));
const disk = () => fs.readFile(path.join(root, FILE), 'utf8');

function lastToolMessage(req: MockRequest): string | undefined {
  const last = req.messages[req.messages.length - 1];
  return last?.role === 'tool' ? textOf(last.content) : undefined;
}

let currentSha = '';
function script(req: MockRequest): MockReply {
  if (req.model === 'mock-fallback') return lastToolMessage(req) !== undefined ? { text: 'fallback finished' } : { text: 'fallback model answered' };
  const scenario = scenarioOf(req);
  const toolResult = lastToolMessage(req);
  const edit1 = { old_text: '    return 1', new_text: '    return 10' };
  const edit2 = { old_text: '    return 2', new_text: '    return 20' };
  switch (scenario) {
    case 'edit2':
      if (toolResult !== undefined) return { text: `finished after: ${toolResult.slice(0, 300)}` };
      return { toolCalls: [{ name: 'propose_edit', args: { path: FILE, base_sha256: currentSha, edits: [edit1, edit2], summary: 'bump returns' } }] };
    case 'dup':
      if (toolResult !== undefined) return { text: 'dup finished' };
      return { toolCalls: [0, 1].map(() => ({ name: 'propose_edit', args: { path: FILE, base_sha256: currentSha, edits: [edit1] } })) };
    case 'noisy':
      if (toolResult !== undefined) return { text: `noisy finished: ${toolResult.slice(0, 200)}` };
      return { toolCalls: [{ name: 'propose_edit', args: { path: FILE, base_sha256: currentSha, edits: [{ ...edit1, why: 'extra' }], explanation: 'models add keys' } }] };
    case 'cmd':
      if (toolResult !== undefined) return { text: `cmd finished: ${toolResult.slice(0, 300)}` };
      return { toolCalls: [{ name: 'run_command', args: { command: 'echo made > made.txt && echo ran' } }] };
    case 'edit-then-500':
      if (toolResult !== undefined) return { status: 500, message: 'mock upstream exploded' };
      return { toolCalls: [{ name: 'propose_edit', args: { path: FILE, base_sha256: currentSha, edits: [edit1] } }] };
    case 'stall':
      return { text: 'thinking ... ... ...', delayMsPerWord: 4000 };
    case 'slow':
      return { text: Array.from({ length: 60 }, (_, i) => `word${i}`).join(' '), delayMsPerWord: 150 };
    default:
      return { text: `hello from ${req.model}` };
  }
}

const AGENTS: Array<[string, string]> = [
  ['it-coder', 'itgood/primary'], ['it-coder-fallback', 'itfb/fb'],
  ['it-auth', 'itbad/primary'], ['it-auth-fallback', 'itfb/fb'],
  ['it-dead', 'itdead/primary'], ['it-dead-fallback', 'itfb/fb'],
  ['it-both', 'itbad/primary'], ['it-both-fallback', 'itdead/primary'],
];

before(async () => {
  await mock.start(MOCK_PORT);
  mock.handler = script;
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-it-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  port = new FakePort(root);
  const { client } = await createClient(TF_URL);
  const base = `http://127.0.0.1:${MOCK_PORT}/v1`;
  const providers = [
    { name: 'itgood', baseUrl: base, apiKey: MOCK_KEY, models: [{ name: 'primary', modelId: 'mock-primary' }] },
    { name: 'itfb', baseUrl: base, apiKey: MOCK_KEY, models: [{ name: 'fb', modelId: 'mock-fallback' }] },
    { name: 'itbad', baseUrl: base, apiKey: 'wrong-key', models: [{ name: 'primary', modelId: 'mock-primary' }] },
    { name: 'itdead', baseUrl: 'http://127.0.0.1:47799/v1', apiKey: MOCK_KEY, models: [{ name: 'primary', modelId: 'mock-primary' }] },
  ];
  for (const p of providers) {
    await client.settings.modelProviders.createOrUpdate({
      manifest: { type: 'custom', name: p.name, baseUrl: p.baseUrl, auth: { apiKey: p.apiKey }, models: p.models.map((m) => ({ ...m, properties: { contextLength: 128000, maxOutputTokens: 2048 } })) },
    });
  }
  // The connector must exist before agents reference it; the harness re-registers it with its live URL/token.
  await client.settings.mcpServers.createOrUpdate({ manifest: { type: 'remote', name: CONNECTOR, url: 'http://127.0.0.1:1/mcp', description: 'integration tests', auth: { type: 'header', headers: { Authorization: 'Bearer placeholder' } } } });
  for (const [name, model] of AGENTS) {
    const manifest = {
      model: { name: model, params: { parallelToolCalls: false } },
      instructions: 'Integration test agent.',
      mcpServers: [{ name: CONNECTOR, enableTools: ['@all'], preloadTools: ['read_file', 'search_workspace', 'propose_edit', 'run_command'], requireApprovalForTools: ['propose_edit', 'run_command'] }],
      config: {
        sandbox: { enabled: false }, dynamicSubAgents: { enabled: false }, generativeUi: { enabled: false }, askUserQuestions: { enabled: false },
        contextManagement: { compaction: { enabled: true, trigger: { type: 'input_tokens' as const, value: 60000 } }, largeToolResponse: { enabled: false } },
        iterationLimit: 10,
      },
    };
    const page = await client.agents.list({ agentName: name });
    const found = page.data.find((a) => a.name === name);
    if (found) await client.agents.update(found.id, { description: 'integration test agent', manifest });
    else await client.agents.create({ name, description: 'integration test agent', manifest });
  }
});

after(async () => {
  await mock.stop();
  await fs.rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, FILE), ORIGINAL);
  currentSha = await fileSha();
  port.mode = 'save';
  port.applyDelayMs = 0;
  port.onApplyStart = undefined;
  port.applies.length = 0;
  mock.requests.length = 0;
});

async function withHarness<T>(agent: string, fn: (h: ForgeHarness, sessionId: string) => Promise<T>, watchdogMs = 15000): Promise<T> {
  const h = createHarness({ trueforgeUrl: TF_URL, mcpPort: 0, connectorName: CONNECTOR, agents: { agent, inline: agent }, retryDelayMs: 300, watchdogMs, cancelTimeoutMs: 5000 });
  await h.start(port);
  try {
    const s = await h.createSession({ version: PROTOCOL_VERSION, requestId: rid(), body: { workspaceRoot: root } });
    assert.ok(s.ok);
    return await fn(h, s.ok ? s.body.sessionId : '');
  } finally {
    await h.dispose();
  }
}

type Ctl = { h: ForgeHarness; sessionId: string; turnId: string };

async function runTurn(h: ForgeHarness, sessionId: string, instruction: string, onEvent?: (e: HarnessEvent, ctl: Ctl) => Promise<void> | void): Promise<HarnessEvent[]> {
  const turnId = `turn-${++seq}`;
  const sub = await h.submitTurn({ version: PROTOCOL_VERSION, requestId: rid(), body: { sessionId, turnId, mode: 'agent', instruction } });
  assert.ok(sub.ok, JSON.stringify(sub));
  const events: HarnessEvent[] = [];
  const deadline = setTimeout(() => { throw new Error(`turn ${turnId} did not finish in time`); }, 45000);
  for await (const r of h.stream({ version: PROTOCOL_VERSION, requestId: rid(), body: { sessionId, turnId, afterSequence: 0 } })) {
    assert.ok(r.ok, JSON.stringify(r));
    if (!r.ok) break;
    events.push(r.body);
    if (onEvent) await onEvent(r.body, { h, sessionId, turnId });
  }
  clearTimeout(deadline);
  return events;
}

const ofType = <T extends HarnessEvent['t']>(events: HarnessEvent[], t: T) => events.filter((e): e is Extract<HarnessEvent, { t: T }> => e.t === t);
const doneOf = (events: HarnessEvent[]) => {
  const d = ofType(events, 'done');
  assert.equal(d.length, 1, 'exactly one done');
  assert.equal(events[events.length - 1]!.t, 'done', 'done is last');
  return d[0]!;
};
function assertSequence(events: HarnessEvent[]): void {
  events.forEach((e, i) => assert.equal(e.sequence, i + 1));
}

async function review(h: ForgeHarness, e: Extract<HarnessEvent, { t: 'review_request' }>, decide: (hunkId: string, i: number) => 'accept' | 'reject', reason?: string) {
  const p = e.proposal;
  const decision: ReviewDecision = {
    sessionId: p.sessionId, turnId: p.turnId, callId: p.callId, kind: 'edit', proposalId: p.proposalId,
    hunks: Object.fromEntries(p.hunks.map((hk, i) => [hk.hunkId, decide(hk.hunkId, i)])), ...(reason ? { reason } : {}),
  };
  const r = await h.submitReview({ version: PROTOCOL_VERSION, requestId: rid(), body: decision });
  assert.ok(r.ok, JSON.stringify(r));
}

test('allow: review, accept all, edit saved, turn done', async () => {
  await withHarness('it-coder', async (h, sid) => {
    const events = await runTurn(h, sid, 'SCENARIO:edit2 bump the return values of alpha and beta', async (e) => {
      if (e.t === 'review_request') await review(h, e, () => 'accept');
    });
    assertSequence(events);
    assert.equal(doneOf(events).status, 'done');
    const reviewReq = ofType(events, 'review_request')[0]!;
    assert.equal(reviewReq.proposal.hunks.length, 2);
    assert.equal(reviewReq.proposal.hunks[0]!.hunkId, `${reviewReq.proposal.proposalId}#0`);
    const applied = ofType(events, 'edit_applied');
    assert.equal(applied.length, 1);
    assert.equal(applied[0]!.result.status, 'saved');
    assert.equal(await disk(), ORIGINAL.replace('return 1', 'return 10').replace('return 2', 'return 20'));
    const session = ofType(events, 'session')[0]!;
    assert.match(session.traceUrl, /sessionId=/);
    assert.equal(session.model, 'itgood/primary');
    assert.ok(ofType(events, 'tool_call').some((t) => t.tool === 'propose_edit' && t.requiresApproval));
    const ctx = ofType(events, 'context_report');
    assert.equal(ctx.length, 1, 'context is assembled once before the turn');
    assert.ok(ctx[0]!.report.selections.some((s) => s.path === FILE && s.source === 'automatic'));
    assert.ok(events.indexOf(ctx[0]!) < events.findIndex((e) => e.t === 'session'), 'context report precedes the TrueForge session');
    assert.ok(ofType(events, 'tool_result').some((t) => t.ok));
  });
});

test('partial accept: only the accepted hunk is written and the model is told', async () => {
  await withHarness('it-coder', async (h, sid) => {
    const events = await runTurn(h, sid, 'SCENARIO:edit2 bump both', async (e) => {
      if (e.t === 'review_request') await review(h, e, (_id, i) => (i === 0 ? 'accept' : 'reject'), 'keep beta');
    });
    assert.equal(doneOf(events).status, 'done');
    assert.equal(await disk(), ORIGINAL.replace('return 1', 'return 10'));
    const toolMsg = mock.requests.map(lastToolMessage).find((m) => m?.includes('Applied hunks'));
    assert.match(toolMsg ?? '', /Applied hunks \[0\] of 2/);
    assert.match(toolMsg ?? '', /user said: keep beta/);
  });
});

test('deny: all hunks rejected, nothing written, reason reaches the model', async () => {
  await withHarness('it-coder', async (h, sid) => {
    const events = await runTurn(h, sid, 'SCENARIO:edit2 bump both', async (e) => {
      if (e.t === 'review_request') await review(h, e, () => 'reject', 'wrong approach');
    });
    assert.equal(doneOf(events).status, 'done');
    assert.equal(ofType(events, 'edit_applied').length, 0);
    assert.equal(await disk(), ORIGINAL);
    assert.equal(port.applies.length, 0, 'the editor was never asked to apply');
    assert.ok(mock.requests.some((r) => (lastToolMessage(r) ?? '').includes('user rejected the change: wrong approach')));
    assert.ok(ofType(events, 'tool_result').some((t) => !t.ok));
  });
});

test('duplicate identical calls in one step: one review, the duplicate is denied', async () => {
  await withHarness('it-coder', async (h, sid) => {
    const events = await runTurn(h, sid, 'SCENARIO:dup', async (e) => {
      if (e.t === 'review_request') await review(h, e, () => 'accept');
    });
    assert.equal(doneOf(events).status, 'done');
    assert.equal(ofType(events, 'review_request').length, 1);
    assert.equal(ofType(events, 'edit_applied').length, 1);
    assert.equal(await disk(), ORIGINAL.replace('return 1', 'return 10'));
    assert.ok(mock.requests.some((r) => r.messages.some((m) => m.role === 'tool' && textOf(m.content).includes('duplicate of another identical call'))));
  });
});

test('cancel while paused for review: confirmed, nothing written, late decision refused', async () => {
  await withHarness('it-coder', async (h, sid) => {
    let cancelStatus: string | undefined;
    let late: unknown;
    const events = await runTurn(h, sid, 'SCENARIO:edit2', async (e, ctl) => {
      if (e.t === 'review_request') {
        const c = await h.cancel({ version: PROTOCOL_VERSION, requestId: rid(), body: { sessionId: ctl.sessionId, turnId: ctl.turnId } });
        cancelStatus = c.ok ? c.body : 'error';
        const p = e.proposal;
        late = await h.submitReview({ version: PROTOCOL_VERSION, requestId: rid(), body: { sessionId: p.sessionId, turnId: p.turnId, callId: p.callId, kind: 'edit', proposalId: p.proposalId, hunks: Object.fromEntries(p.hunks.map((x) => [x.hunkId, 'accept'])) } });
      }
    });
    assert.equal(cancelStatus, 'confirmed');
    assert.equal(doneOf(events).status, 'cancelled');
    assert.equal(await disk(), ORIGINAL);
    assert.equal((late as { ok: boolean }).ok, false);
  });
});

test('cancel while streaming: confirmed quickly, done cancelled', async () => {
  await withHarness('it-coder', async (h, sid) => {
    let cancelStatus: string | undefined;
    let ms = 0;
    const events = await runTurn(h, sid, 'SCENARIO:slow', async (e, ctl) => {
      if (e.t === 'text' && cancelStatus === undefined) {
        cancelStatus = 'pending';
        const t0 = Date.now();
        const c = await h.cancel({ version: PROTOCOL_VERSION, requestId: rid(), body: { sessionId: ctl.sessionId, turnId: ctl.turnId } });
        ms = Date.now() - t0;
        cancelStatus = c.ok ? c.body : 'error';
      }
    });
    assert.equal(cancelStatus, 'confirmed');
    assert.ok(ms < 2000, `cancel took ${ms} ms`);
    assert.equal(doneOf(events).status, 'cancelled');
  });
});

test('cancel racing an in-flight apply: done waits, the write is reported before done', async () => {
  await withHarness('it-coder', async (h, sid) => {
    port.applyDelayMs = 1500;
    let ctlRef: Ctl | undefined;
    port.onApplyStart = () => {
      if (ctlRef) void h.cancel({ version: PROTOCOL_VERSION, requestId: rid(), body: { sessionId: ctlRef.sessionId, turnId: ctlRef.turnId } });
    };
    const events = await runTurn(h, sid, 'SCENARIO:edit2', async (e, ctl) => {
      if (e.t === 'review_request') { ctlRef = ctl; await review(h, e, () => 'accept'); }
    });
    const done = doneOf(events);
    const appliedIdx = events.findIndex((e) => e.t === 'edit_applied');
    assert.ok(appliedIdx >= 0 && appliedIdx < events.length - 1, 'edit_applied is delivered before done');
    assert.equal(done.status, 'cancelled');
    assert.notEqual(await disk(), ORIGINAL, 'the in-flight write completed and was reported');
  });
});

test('401 on primary: immediate fallback that succeeds', async () => {
  await withHarness('it-auth', async (h, sid) => {
    const events = await runTurn(h, sid, 'SCENARIO:plain hi');
    assert.equal(doneOf(events).status, 'done');
    const fb = ofType(events, 'fallback');
    assert.equal(fb.length, 1);
    assert.equal(fb[0]!.fromModel, 'itbad/primary');
    assert.equal(fb[0]!.toModel, 'itfb/fb');
    assert.match(fb[0]!.reason, /401/);
    assert.equal(ofType(events, 'status').filter((s) => s.state === 'retrying').length, 0, 'auth errors are not retried');
    const sessions = ofType(events, 'session');
    assert.equal(sessions.length, 2);
    assert.notEqual(sessions[0]!.runtimeSessionId, sessions[1]!.runtimeSessionId, 'fallback runs in a new TrueForge session');
    assert.ok(events.indexOf(fb[0]!) < events.indexOf(sessions[1]!), 'fallback is announced before the new session');
    assert.ok(ofType(events, 'text').some((t) => t.delta.includes('fallback')));
  });
});

test('refused connection: one retry, then fallback that succeeds', async () => {
  await withHarness('it-dead', async (h, sid) => {
    const events = await runTurn(h, sid, 'SCENARIO:plain hi');
    assert.equal(doneOf(events).status, 'done');
    assert.equal(ofType(events, 'status').filter((s) => s.state === 'retrying').length, 1);
    assert.equal(ofType(events, 'fallback').length, 1);
    assert.match(ofType(events, 'fallback')[0]!.reason, /Cannot connect to API/);
  });
});

test('fallback also fails: clear error, single done', async () => {
  await withHarness('it-both', async (h, sid) => {
    const events = await runTurn(h, sid, 'SCENARIO:plain hi');
    assert.equal(doneOf(events).status, 'error');
    const errors = ofType(events, 'error');
    assert.equal(errors.length, 1);
    assert.match(errors[0]!.error.message, /fallback model also failed/);
    assert.equal(errors[0]!.error.workspaceEffect, 'unchanged');
    assert.equal(ofType(events, 'fallback').length, 1);
  });
});

test('error after a write: no retry, no fallback, workspace reported changed', async () => {
  await withHarness('it-coder', async (h, sid) => {
    const events = await runTurn(h, sid, 'SCENARIO:edit-then-500', async (e) => {
      if (e.t === 'review_request') await review(h, e, () => 'accept');
    });
    assert.equal(doneOf(events).status, 'error');
    assert.equal(ofType(events, 'fallback').length, 0);
    assert.equal(ofType(events, 'status').filter((s) => s.state === 'retrying').length, 0);
    const errors = ofType(events, 'error');
    assert.equal(errors[0]!.error.workspaceEffect, 'changed');
    assert.match(errors[0]!.error.message, /no retry or fallback/);
    assert.equal(await disk(), ORIGINAL.replace('return 1', 'return 10'));
  });
});

test('watchdog: a stalled model is stopped, retried once, then replaced by the fallback', async () => {
  await withHarness('it-coder', async (h, sid) => {
    const events = await runTurn(h, sid, 'SCENARIO:stall');
    assert.equal(doneOf(events).status, 'done');
    const retrying = ofType(events, 'status').filter((s) => s.state === 'retrying');
    assert.equal(retrying.length, 1);
    assert.match(retrying[0]!.detail ?? '', /no response from the model/);
    assert.equal(ofType(events, 'fallback').length, 1);
    assert.ok(ofType(events, 'text').some((t) => t.delta.includes('fallback')));
  }, 1000);
});

test('extra keys from the model do not break the approval binding', async () => {
  await withHarness('it-coder', async (h, sid) => {
    const events = await runTurn(h, sid, 'SCENARIO:noisy', async (e) => {
      if (e.t === 'review_request') await review(h, e, () => 'accept');
    });
    assert.equal(doneOf(events).status, 'done');
    assert.equal(ofType(events, 'edit_applied').length, 1);
    assert.equal(await disk(), ORIGINAL.replace('return 1', 'return 10'));
  });
});

test('run_command: approval prompt, execution, changed-file report', async () => {
  await withHarness('it-coder', async (h, sid) => {
    let prompt: Extract<HarnessEvent, { t: 'command_request' }> | undefined;
    const events = await runTurn(h, sid, 'SCENARIO:cmd', async (e, ctl) => {
      if (e.t === 'command_request') {
        prompt = e;
        const r = await h.submitReview({ version: PROTOCOL_VERSION, requestId: rid(), body: { sessionId: ctl.sessionId, turnId: ctl.turnId, callId: e.callId, kind: 'command', allow: true } });
        assert.ok(r.ok, JSON.stringify(r));
      }
    });
    assert.equal(doneOf(events).status, 'done');
    assert.equal(prompt?.command, 'echo made > made.txt && echo ran');
    assert.equal(prompt?.cwd, '.');
    assert.equal(await fs.readFile(path.join(root, 'made.txt'), 'utf8'), 'made\n');
    assert.ok(ofType(events, 'status').some((s) => /command exited 0; changed files: made\.txt/.test(s.detail ?? '')));
    assert.ok(mock.requests.some((r) => /Files changed by the command: made\.txt/.test(lastToolMessage(r) ?? '')));
  });
});
