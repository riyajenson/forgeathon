#!/usr/bin/env node
// Recording-day pre-flight: ONE tiny chat request (max_tokens 1) straight to the primary model's provider, to
// see whether its key works and is not rate limited before you start recording. It is a check outside the
// product: the extension itself only ever talks to TrueForge.
//
// Usage: node scripts/preflight-model.mjs [--config config/models.json] [--model <provider>/<model>]
// Exit codes: 0 ready · 3 rate limited (429): switch profile · 2 any other failure.
// Keys come from the environment variable named in the config (source ~/.forge-keys.env); never printed.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback; };
const configPath = path.resolve(arg('--config', path.join(repo, 'config', 'models.json')));

function done(code, line) { console.log(line); process.exit(code); }

let cfg;
try { cfg = JSON.parse(readFileSync(configPath, 'utf8')); } catch (e) {
  done(2, `cannot read ${configPath}: ${e.message}. Run scripts/use-models.sh nvidia-free first.`);
}
const target = arg('--model', cfg.agents?.primaryModel ?? '');
const [providerName, modelName] = target.split('/');
const provider = (cfg.providers ?? []).find((p) => (p.name ?? p.type) === providerName);
const model = provider?.models?.find((m) => m.name === modelName);
if (!provider || !model) done(2, `${target || '(no primary model)'} is not in ${configPath}`);
if (provider.type !== 'custom' || !provider.baseUrl) done(2, `${target}: pre-flight supports OpenAI-compatible (custom) providers only`);
const key = provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : undefined;
if (!key) done(2, `${provider.apiKeyEnv ?? 'the API key variable'} is not set: source ~/.forge-keys.env first`);

// Profiles to suggest when this provider is throttled: free ones whose primary is another provider.
const profiles = Object.entries(cfg.profiles ?? {});
const alternatives = profiles.filter(([, p]) => !p.paid && p.primaryModel.split('/')[0] !== providerName).map(([n]) => n);
const paid = profiles.filter(([, p]) => p.paid).map(([n]) => n);
const scrub = (s) => String(s).split(key).join('***').replace(/\s+/g, ' ').slice(0, 300);

const url = `${provider.baseUrl.replace(/\/+$/, '')}/chat/completions`;
const t0 = Date.now();
let res;
let body = '';
try {
  res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: model.modelId, messages: [{ role: 'user', content: 'Reply with OK.' }], max_tokens: 1, stream: false }),
    signal: AbortSignal.timeout(Number(arg('--timeout-ms', '60000'))),
  });
  body = await res.text();
} catch (e) {
  done(2, `${target}: no answer from ${new URL(url).host} (${scrub(e.cause?.code ?? e.message)}). Check the network, or switch: ${alternatives.map((n) => `scripts/use-models.sh ${n}`).join(' or ') || 'another profile'}`);
}
const ms = Date.now() - t0;
let message = '';
try { const j = JSON.parse(body); message = j.error?.message ?? j.detail ?? j.message ?? ''; } catch { message = body; }

if (res.ok) done(0, `${target}: ready (HTTP ${res.status} in ${ms} ms). Record now.`);
if (res.status === 429) {
  const after = res.headers.get('retry-after');
  const lines = [
    `${target}: RATE LIMITED (HTTP 429${after ? `, Retry-After ${after} s` : ', no Retry-After'}) in ${ms} ms: ${scrub(message)}`,
    alternatives.length
      ? `Switch before recording: scripts/use-models.sh ${alternatives[0]}   (then run this pre-flight again)`
      : 'No free profile with another primary provider is configured; wait and try again later.',
  ];
  if (paid.length) lines.push(`Only if you have added OpenRouter credit: scripts/use-models.sh ${paid[0]} --paid-ok`);
  done(3, lines.join('\n'));
}
if (res.status === 401 || res.status === 403) done(2, `${target}: the key was refused (HTTP ${res.status}): ${scrub(message)}. Check ${provider.apiKeyEnv}.`);
done(2, `${target}: HTTP ${res.status} in ${ms} ms: ${scrub(message)}`);
