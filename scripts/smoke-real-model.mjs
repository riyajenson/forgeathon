#!/usr/bin/env node
// Real-model smoke test of Tasks A/B (and C with --tasks A,B,C) on a temporary copy of Flask 3.1.3.
// Needs: TrueForge running, `node scripts/setup-trueforge.mjs` done with real keys, harness built.
// Usage: node scripts/smoke-real-model.mjs [--flask ~/projects/flask-3.1.3] [--tasks A,B,C] [--keep]
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(repo, 'src', 'harness', 'dist', 'src', 'harness', 'smoke', 'smoke.js');
if (!existsSync(entry)) {
  console.error('src/harness is not built. Run: npm --prefix src/harness ci && npm --prefix src/harness run build');
  process.exit(1);
}
createRequire(import.meta.url)(entry);
