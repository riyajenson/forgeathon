// Tests for scripts/use-models.sh in a temporary config directory, with the setup script in --dry-run mode
// (no TrueForge, no model requests). Run: node --test scripts/use-models.test.mjs (needs src/harness built).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(repo, 'scripts', 'use-models.sh');
const KEYS = { NVIDIA_API_KEY: 'nv-dummy-111', OPENROUTER_API_KEY: 'or-dummy-222', GROQ_API_KEY: 'gq-dummy-333' };

function dir() {
  const d = mkdtempSync(path.join(os.tmpdir(), 'forge-use-models-'));
  copyFileSync(path.join(repo, 'config', 'models.example.json'), path.join(d, 'models.example.json'));
  return d;
}
function run(d, args, keys = KEYS) {
  const env = { ...process.env, FORGE_CONFIG_DIR: d };
  for (const k of Object.keys(KEYS)) delete env[k];
  Object.assign(env, keys);
  const r = spawnSync('bash', [script, ...args], { env, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
const agents = (d) => JSON.parse(readFileSync(path.join(d, 'models.json'), 'utf8')).agents;
const noKeys = (out) => { for (const v of Object.values(KEYS)) assert.ok(!out.includes(v), 'no key in the output'); };

test('default profile nvidia-free: NVIDIA primary, OpenRouter fallback, setup re-run with both agents', () => {
  const d = dir();
  const r = run(d, ['--', '--dry-run']);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(agents(d), { primaryModel: 'nvidia/nemotron-3-ultra', fallbackModel: 'openrouter/nemotron-3-ultra-free' });
  assert.match(r.out, /agent forge-coder: would upsert with model nvidia\/nemotron-3-ultra/);
  assert.match(r.out, /agent forge-coder-fallback: would upsert with model openrouter\/nemotron-3-ultra-free/);
  noKeys(r.out);
});

test('openrouter-free swaps the pair and keeps the previous config as .bak', () => {
  const d = dir();
  assert.equal(run(d, ['nvidia-free', '--', '--dry-run']).code, 0);
  const r = run(d, ['openrouter-free', '--', '--dry-run']);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(agents(d), { primaryModel: 'openrouter/nemotron-3-ultra-free', fallbackModel: 'nvidia/nemotron-3-ultra' });
  assert.equal(JSON.parse(readFileSync(path.join(d, 'models.json.bak'), 'utf8')).agents.primaryModel, 'nvidia/nemotron-3-ultra');
});

test('openrouter-paid is refused without --paid-ok and leaves models.json alone', () => {
  const d = dir();
  writeFileSync(path.join(d, 'models.json'), 'untouched');
  const r = run(d, ['openrouter-paid', '--', '--dry-run']);
  assert.equal(r.code, 2);
  assert.match(r.out, /PAID model \(openrouter\/qwen3-coder-next\)/);
  assert.equal(readFileSync(path.join(d, 'models.json'), 'utf8'), 'untouched');
  const ok = run(d, ['openrouter-paid', '--paid-ok', '--', '--dry-run']);
  assert.equal(ok.code, 0, ok.out);
  assert.equal(agents(d).primaryModel, 'openrouter/qwen3-coder-next');
});

test('missing keys and unknown profiles are refused before anything is written', () => {
  const d = dir();
  const r = run(d, ['nvidia-free'], {});
  assert.equal(r.code, 2);
  assert.match(r.out, /NVIDIA_API_KEY and OPENROUTER_API_KEY not set/);
  assert.equal(existsSync(path.join(d, 'models.json')), false);
  const u = run(d, ['fastest']);
  assert.equal(u.code, 2);
  assert.match(u.out, /unknown profile "fastest"; profiles: nvidia-free, openrouter-free, openrouter-paid/);
});

test('--break-primary names the primary key it replaces (Task C) without printing any key; --list shows profiles', () => {
  const d = dir();
  const r = run(d, ['openrouter-free', '--break-primary', '--', '--dry-run']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /primary model \(openrouter\/nemotron-3-ultra-free\) is registered with an invalid key; restore with: .*use-models\.sh openrouter-free/);
  noKeys(r.out);
  const l = run(d, ['--list']);
  assert.equal(l.code, 0);
  assert.match(l.out, /openrouter-paid +openrouter\/qwen3-coder-next → fallback nvidia\/nemotron-3-ultra +\[PAID\]/);
});
