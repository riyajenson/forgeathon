// Scenario runner for the P0 spike. Usage: node run.mjs <allow|deny|deferred|cancel|cancelrun|err401|errRefused> [label]
import fs from 'node:fs';
import { TrueForge, isEventDelta, mergeEventDelta } from '@truefoundry/trueforge-sdk';

const scenario = process.argv[2];
const label = process.argv[3] ?? scenario;
const client = new TrueForge({ baseUrl: 'http://127.0.0.1:8790', timeoutInSeconds: 600, maxRetries: 0 });
fs.mkdirSync('logs', { recursive: true });
const out = fs.createWriteStream(`logs/${label}.jsonl`);
const t0 = Date.now();
const seenIds = new Set();
const duplicates = [];
const messages = new Map(); // model.message id -> merged event

function note(phase, event) {
  const t = Date.now() - t0;
  if (!isEventDelta(event)) {
    if (seenIds.has(event.id)) duplicates.push({ phase, id: event.id, type: event.type });
    seenIds.add(event.id);
  }
  const brief = { t, phase, type: event.type, id: event.id };
  if (event.type === 'turn.created') brief.turnId = event.turnId;
  if (event.type === 'turn.update' || event.type === 'turn.done') brief.state = event.state;
  if (event.type === 'tool.approval_required') brief.toolCalls = event.toolCalls;
  if (event.type === 'tool.response') { brief.toolCallId = event.toolCallId; brief.content = event.content; }
  if (event.type === 'mcp.initialize') brief.event = event;
  out.write(JSON.stringify({ ...brief, raw: isEventDelta(event) ? undefined : event }) + '\n');
  if (event.type !== 'model.message.delta') console.log(JSON.stringify(brief));

  if (event.type === 'model.message') messages.set(event.id, structuredClone(event));
  else if (isEventDelta(event)) {
    const base = messages.get(event.id);
    if (base) mergeEventDelta(base, event);
    else messages.set(event.id, { ...structuredClone(event), type: 'model.message' });
  }
}

function toolCallFor(ref) {
  const msg = messages.get(ref.sourceEventId);
  return msg?.toolCalls?.find((c) => c.id === ref.toolCallId || c.id === ref.id);
}

const agentName = process.env.AGENT ?? { err401: 'spike-401', errRefused: 'spike-refused', errHole: 'spike-hole' }[scenario] ?? 'spike-agent';
const prompt = {
  read: 'SCENARIO:read show the file',
  allow: 'SCENARIO:propose please edit',
  deny: 'SCENARIO:propose please edit',
  cancel: 'SCENARIO:propose please edit',
  deferred: 'SCENARIO:deferred find get_debug_flag',
  cancelrun: 'SCENARIO:slow talk slowly',
}[scenario] ?? 'SCENARIO:plain hello';

const { data: session } = await client.sessions.create({ agent: { name: agentName }, metadata: { spike: label } });
console.log(`session ${session.id} agent=${agentName} scenario=${scenario}`);

let turnId;
let paused;
let done;
const stream = await client.sessions.createTurnStream(session.id, { input: [{ type: 'user.message', content: prompt }] });
let cancelTimer;
if (scenario === 'cancelrun') {
  cancelTimer = setTimeout(async () => {
    console.log(`t=${Date.now() - t0} cancelling while running`);
    await client.sessions.cancel(session.id);
    console.log(`t=${Date.now() - t0} cancel() returned`);
  }, 2000);
}
for await (const event of stream) {
  note('initial', event);
  if (event.type === 'turn.created') turnId = event.turnId;
  if (event.type === 'tool.approval_required') paused = { approval: event };
  if (event.type === 'turn.update' && event.state.status === 'paused') { paused = { ...paused, lastEventId: event.id }; break; }
  if (event.type === 'turn.done') { done = event; break; }
}
clearTimeout(cancelTimer);

if (paused && !done) {
  const refs = paused.approval?.toolCalls ?? [];
  for (const ref of refs) console.log('pending call:', JSON.stringify({ ref, call: toolCallFor(ref) }));
  // Subscribe first, then act, then read: nothing can be emitted between the act and the subscription.
  const sub = await client.sessions.subscribeToTurn(session.id, turnId, { afterEventId: paused.lastEventId });
  if (scenario === 'cancel') {
    console.log(`t=${Date.now() - t0} cancelling while paused`);
    await client.sessions.cancel(session.id);
    console.log(`t=${Date.now() - t0} cancel() returned`);
  } else {
    const decision = scenario === 'deny'
      ? { status: 'deny', reason: 'SPIKE_DENY_REASON: user rejected hunk 1 because it renames x' }
      : { status: 'allow' };
    await client.sessions.createTurnEvents(session.id, turnId, {
      events: refs.map((ref) => ({ type: 'user.tool_approval', threadId: paused.approval.threadId, toolCallId: ref.id, approval: decision })),
    });
    console.log(`t=${Date.now() - t0} sent ${decision.status} for ${refs.length} call(s)`);
  }
  for await (const event of sub) {
    note('resumed', event);
    if (event.type === 'turn.done') { done = event; break; }
  }
}

const finalText = [...messages.values()].map((m) => (typeof m.content === 'string' ? m.content : '')).filter(Boolean);
const summary = {
  label, scenario, sessionId: session.id, turnId, elapsedMs: Date.now() - t0,
  final: done?.state, duplicates, assistantText: finalText,
  toolCalls: [...messages.values()].flatMap((m) => m.toolCalls ?? []).map((c) => ({ id: c.id, name: c.function?.name, arguments: c.function?.arguments, toolInfo: c.toolInfo })),
};
fs.writeFileSync(`logs/${label}.summary.json`, JSON.stringify(summary, null, 2));
console.log('SUMMARY', JSON.stringify(summary, null, 2));
out.end();
