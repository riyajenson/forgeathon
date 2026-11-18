#!/usr/bin/env node
// Registers model providers, the editor MCP connector and the agents in a running local TrueForge.
// Usage: node scripts/setup-trueforge.mjs [--config config/models.json] [--url http://127.0.0.1:8790] [--dry-run]
// Build the harness first: npm --prefix src/harness ci && npm --prefix src/harness run build
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repo, 'src', 'harness', 'dist', 'setup', 'cli.js');
if (!existsSync(cli)) {
  console.error('src/harness is not built. Run: npm --prefix src/harness ci && npm --prefix src/harness run build');
  process.exit(1);
}
createRequire(import.meta.url)(cli);
