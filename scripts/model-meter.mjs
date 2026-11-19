#!/usr/bin/env node
// Model request meter: a loopback pass-through proxy that counts every request TrueForge sends to a model
// provider (including TrueForge's internal retries after a 429) and logs status, duration, Retry-After and
// token usage per request. It never logs bodies, headers or keys.
//
//   node scripts/model-meter.mjs --port 47800 --log meter.jsonl \
//     --route nvidia=https://integrate.api.nvidia.com/v1 --route groq=https://api.groq.com/openai/v1
//   node scripts/model-meter.mjs --summary meter.jsonl
//
// Point each provider's baseUrl at http://127.0.0.1:47800/<route> in a copy of config/models.json, rerun setup
// with --config <copy>, and pass --meter-log meter.jsonl to scripts/smoke-real-model.mjs for per-task counts.
// TrueForge must allow loopback (OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1"]', as in the README).
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repo, 'src', 'harness', 'dist', 'src', 'harness', 'meter', 'cli.js');
if (!existsSync(cli)) {
  console.error('src/harness is not built. Run: npm --prefix src/harness ci && npm --prefix src/harness run build');
  process.exit(1);
}
createRequire(import.meta.url)(cli);
