import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockModel, MOCK_KEY } from '../testing/mock-model';
import { meterRecordsSince, requestStats, startMeter, summarise, usageOf, type MeterRecord } from './meter';

async function post(url: string, key: string, body: unknown): Promise<{ status: number; text: string; retryAfter: string | null }> {
  const r = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, text: await r.text(), retryAfter: r.headers.get('retry-after') };
}

test('meter forwards streamed responses unchanged and records status, model, tokens, 429 and Retry-After without bodies or keys', async () => {
  const model = new MockModel();
  let n = 0;
  model.handler = () => (++n === 2 ? { status: 429, message: 'rate limited SECRET-BODY', headers: { 'retry-after': '7' } } : { text: 'hello SECRET-BODY' });
  await model.start();
  const records: MeterRecord[] = [];
  const meter = await startMeter({ routes: { demo: `http://127.0.0.1:${model.port}/v1/` }, onRecord: (r) => records.push(r) });
  try {
    const url = `http://127.0.0.1:${meter.port}/demo/chat/completions`;
    const ok = await post(url, MOCK_KEY, { model: 'demo-primary', stream: true, messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(ok.status, 200);
    assert.match(ok.text, /hello/, 'the client gets the upstream stream');
    assert.match(ok.text, /\[DONE\]/);
    const limited = await post(url, MOCK_KEY, { model: 'demo-primary', stream: true, messages: [] });
    assert.equal(limited.status, 429);
    assert.equal(limited.retryAfter, '7', 'Retry-After reaches TrueForge');
    const bad = await post(url, 'wrong-key', { model: 'demo-fallback', messages: [] });
    assert.equal(bad.status, 401);
    const unknown = await fetch(`http://127.0.0.1:${meter.port}/nope/chat/completions`, { method: 'POST', body: '{}' });
    assert.equal(unknown.status, 404);

    await new Promise((r) => setTimeout(r, 20));
    assert.equal(records.length, 3, 'one record per upstream request; unknown routes are not forwarded');
    assert.deepEqual(records.map((r) => [r.route, r.path, r.model, r.status]), [
      ['demo', '/chat/completions', 'demo-primary', 200],
      ['demo', '/chat/completions', 'demo-primary', 429],
      ['demo', '/chat/completions', 'demo-fallback', 401],
    ]);
    assert.equal(records[0]!.inputTokens, 10);
    assert.equal(records[0]!.outputTokens, 5);
    assert.equal(records[1]!.retryAfter, '7');
    assert.equal(model.requests[0]!.authOk, true, 'the key is forwarded to the upstream');
    const logged = JSON.stringify(records);
    assert.doesNotMatch(logged, /SECRET-BODY|itest-good-key|wrong-key|hello/, 'no bodies or keys in the records');

    assert.deepEqual(summarise(records), {
      'demo demo-primary': { requests: 2, ok: 1, status429: 1, otherErrors: 0, inputTokens: 10, outputTokens: 5 },
      'demo demo-fallback': { requests: 1, ok: 0, status429: 0, otherErrors: 1, inputTokens: 0, outputTokens: 0 },
    });
  } finally {
    await meter.close();
    await model.stop();
  }
});

test('meter records an unreachable upstream as status 0', async () => {
  const records: MeterRecord[] = [];
  const meter = await startMeter({ routes: { gone: 'http://127.0.0.1:9/v1' }, onRecord: (r) => records.push(r) });
  try {
    const r = await post(`http://127.0.0.1:${meter.port}/gone/chat/completions`, 'k', { model: 'm' });
    assert.equal(r.status, 502);
    assert.equal(records.length, 1);
    assert.equal(records[0]!.status, 0);
    assert.equal(records[0]!.model, 'm');
  } finally {
    await meter.close();
  }
});

test('usage is read from a JSON body or the last SSE usage chunk', () => {
  assert.deepEqual(usageOf('{"usage":{"prompt_tokens":12,"completion_tokens":3}}'), { inputTokens: 12, outputTokens: 3 });
  assert.deepEqual(usageOf('data: {"choices":[]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":2}}\n\ndata: [DONE]\n\n'), { inputTokens: 7, outputTokens: 2 });
  assert.equal(usageOf('data: {"choices":[]}\n\ndata: [DONE]'), undefined);
  assert.equal(usageOf('{"error":{"message":"x"}}'), undefined);
});

test('per-task request stats from the part of the meter log written during the task', async () => {
  const { mkdtemp, writeFile, appendFile, rm } = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'meter-'));
  const file = path.join(dir, 'meter.jsonl');
  const rec = (route: string, model: string, status: number): string => `${JSON.stringify({ ts: 't', route, path: '/chat/completions', model, status, ms: 1 })}\n`;
  try {
    assert.deepEqual(await meterRecordsSince(file, 0), { lines: 0, records: [] }, 'missing log: nothing yet');
    assert.deepEqual(await meterRecordsSince(undefined, 0), { lines: 0, records: [] });
    await writeFile(file, rec('nvidia', 'a', 200));
    const before = (await meterRecordsSince(file, 0)).lines;
    await appendFile(file, rec('nvidia', 'a', 401) + rec('groq', 'b', 429) + rec('groq', 'b', 200));
    const { records } = await meterRecordsSince(file, before);
    assert.deepEqual(requestStats(records), { total: 3, status429: 1, otherErrors: 1, byModel: { 'nvidia a': 1, 'groq b': 2 } });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('min-interval pacing: concurrent requests on one route start at least the interval apart', async () => {
  const model = new MockModel();
  model.handler = () => ({ text: 'ok' });
  await model.start();
  const records: MeterRecord[] = [];
  const meter = await startMeter({ routes: { demo: `http://127.0.0.1:${model.port}/v1/` }, minIntervalMs: 150, onRecord: (r) => records.push(r) });
  try {
    const url = `http://127.0.0.1:${meter.port}/demo/chat/completions`;
    const body = { model: 'demo-primary', stream: false, messages: [{ role: 'user', content: 'hi' }] };
    const replies = await Promise.all([1, 2, 3, 4].map(() => post(url, MOCK_KEY, body)));
    assert.ok(replies.every((r) => r.status === 200));
    const starts = records.map((r) => Date.parse(r.ts)).sort((a, b) => a - b);
    for (let i = 1; i < starts.length; i++) assert.ok(starts[i]! - starts[i - 1]! >= 140, `starts ${starts[i]! - starts[i - 1]!} ms apart`);
    assert.ok(records.filter((r) => (r.queuedMs ?? 0) > 0).length >= 3, 'later requests waited in the meter');
  } finally {
    await meter.close();
    await model.stop();
  }
});
