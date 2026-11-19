// Tests for scripts/preflight-model.mjs against a local fake provider (no real model requests).
// Run: node --test scripts/preflight-model.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEY = 'pf-dummy-key-987';
let server;
let reply = { status: 200, headers: {}, body: { choices: [{ message: { content: 'OK' } }] } };
const seen = [];

before(async () => {
  server = http.createServer((rq, rs) => {
    let raw = '';
    rq.on('data', (c) => (raw += c));
    rq.on('end', () => {
      seen.push({ url: rq.url, auth: rq.headers.authorization, body: JSON.parse(raw) });
      rs.writeHead(reply.status, { 'content-type': 'application/json', ...reply.headers }).end(JSON.stringify(reply.body));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
});
after(() => server.close());

function config(primary = 'fake/big') {
  const d = mkdtempSync(path.join(os.tmpdir(), 'forge-preflight-'));
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  const cfg = {
    providers: [
      { type: 'custom', name: 'fake', baseUrl: base, apiKeyEnv: 'PF_KEY', models: [{ name: 'big', modelId: 'vendor/big-model' }] },
      { type: 'custom', name: 'other', baseUrl: base, apiKeyEnv: 'PF_KEY', models: [{ name: 'big', modelId: 'vendor/big-model:free' }, { name: 'paidone', modelId: 'vendor/paid' }] },
    ],
    agents: { primaryModel: primary, fallbackModel: 'other/big' },
    profiles: {
      'fake-free': { primaryModel: 'fake/big', fallbackModel: 'other/big' },
      'other-free': { primaryModel: 'other/big', fallbackModel: 'fake/big' },
      'other-paid': { primaryModel: 'other/paidone', fallbackModel: 'fake/big', paid: true },
    },
  };
  const file = path.join(d, 'models.json');
  writeFileSync(file, JSON.stringify(cfg));
  return file;
}

function run(file, extra = [], env = { PF_KEY: KEY }) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(repo, 'scripts', 'preflight-model.mjs'), '--config', file, ...extra], { env: { PATH: process.env.PATH, ...env } });
    let out = '';
    p.stdout.on('data', (c) => (out += c));
    p.stderr.on('data', (c) => (out += c));
    p.on('close', (code) => resolve({ code, out }));
  });
}

test('one tiny request to the primary model; ready on 200', async () => {
  seen.length = 0;
  reply = { status: 200, headers: {}, body: { choices: [] } };
  const r = await run(config());
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /fake\/big: ready \(HTTP 200/);
  assert.equal(seen.length, 1, 'exactly one request');
  assert.equal(seen[0].url, '/v1/chat/completions');
  assert.equal(seen[0].auth, `Bearer ${KEY}`);
  assert.equal(seen[0].body.model, 'vendor/big-model');
  assert.equal(seen[0].body.max_tokens, 1);
  assert.ok(!r.out.includes(KEY));
});

test('429: exit 3 and recommends the free profile with another primary provider (paid only with credit)', async () => {
  seen.length = 0;
  reply = { status: 429, headers: {}, body: { error: { message: `Too Many Requests for key ${KEY}` } } };
  const r = await run(config());
  assert.equal(r.code, 3, r.out);
  assert.match(r.out, /RATE LIMITED \(HTTP 429, no Retry-After\)/);
  assert.match(r.out, /Switch before recording: scripts\/use-models\.sh other-free/);
  assert.match(r.out, /Only if you have added OpenRouter credit: scripts\/use-models\.sh other-paid --paid-ok/);
  assert.ok(!r.out.includes(KEY), 'the key is scrubbed even when the provider echoes it');
  assert.equal(seen.length, 1, 'no retries');
  reply = { status: 429, headers: { 'retry-after': '30' }, body: {} };
  assert.match((await run(config())).out, /Retry-After 30 s/);
});

test('--model checks another configured model; key problems and missing keys exit 2', async () => {
  seen.length = 0;
  reply = { status: 401, headers: {}, body: { error: { message: 'bad key' } } };
  const r = await run(config(), ['--model', 'other/big']);
  assert.equal(r.code, 2);
  assert.match(r.out, /other\/big: the key was refused \(HTTP 401\): bad key\. Check PF_KEY/);
  assert.equal(seen[0].body.model, 'vendor/big-model:free');
  const missing = await run(config(), [], {});
  assert.equal(missing.code, 2);
  assert.match(missing.out, /PF_KEY is not set/);
});
