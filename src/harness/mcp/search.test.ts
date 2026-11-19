import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { FakePort, readFileTool, searchWorkspaceTool, type ToolContext } from './index';
import { listFilesTool } from './symbol-tools';
import { buildIndex } from '../context/workspace-index';
import { LIST_LIMIT } from '../context/files';

let root: string;
let ctx: ToolContext;

const FILES: Record<string, string> = {
  '.gitignore': '*.log\n!keep.log\nsecret/\nbuild-out/\n!build-out/wanted.py\n',
  'app.py': 'needle = 1\n',
  'app.log': 'needle\n',
  'keep.log': 'needle\n',
  'secret/a.py': 'needle\n',
  'build-out/wanted.py': 'needle\n',
  'pkg/.gitignore': 'generated.py\n!important.log\n',
  'pkg/real.py': 'needle\n',
  'pkg/generated.py': 'needle\n',
  'pkg/important.log': 'needle\n',
  'pkg/deep/generated.py': 'needle\n',
  'mylib.egg-info/PKG-INFO.txt': 'needle\n',
  '.env': 'API_KEY=needle\n',
  '.env.example': 'API_KEY=needle\n',
  'config/id_rsa': 'needle\n',
  'backtrack.txt': `${'a'.repeat(32)}!\n`,
};
const VISIBLE = ['.env.example', '.gitignore', 'app.py', 'backtrack.txt', 'keep.log', 'pkg/.gitignore', 'pkg/important.log', 'pkg/real.py'];

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-search-'));
  for (const [rel, text] of Object.entries(FILES)) {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), text);
  }
  ctx = { port: new FakePort(root), scope: undefined };
});
after(async () => { await fs.rm(root, { recursive: true, force: true }); });

test('nested .gitignore files, negation, ignored parents, default excludes and credentials files', async () => {
  const r = await listFilesTool(ctx, {});
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(r.text.split('\n').slice(1).sort(), VISIBLE);
  const s = await searchWorkspaceTool(ctx, { query: 'needle' });
  assert.ok(s.ok);
  if (!s.ok) return;
  const hitFiles = [...new Set(s.text.split('\n').slice(1).map((l) => l.split(':')[0]))].sort();
  assert.deepEqual(hitFiles, ['.env.example', 'app.py', 'keep.log', 'pkg/important.log', 'pkg/real.py']);
});

test('read_file refuses credentials files', async () => {
  for (const p of ['.env', 'config/id_rsa']) {
    const r = await readFileTool(ctx, { path: p });
    assert.equal(!r.ok && r.code, 'SECRET_FILE', p);
  }
  assert.equal((await readFileTool(ctx, { path: '.env.example' })).ok, true);
});

test('a catastrophic regex is stopped at the deadline and never blocks the event loop', async () => {
  let ticks = 0;
  const tick = setInterval(() => { ticks++; }, 20);
  const t0 = Date.now();
  const r = await searchWorkspaceTool(ctx, { query: '(a+)+$', regex: true });
  clearInterval(tick);
  const ms = Date.now() - t0;
  assert.equal(!r.ok && r.code, 'TIMEOUT');
  assert.ok(ms < 4000, `stopped after ${ms} ms`);
  assert.ok(ticks >= 20, `the event loop kept running (${ticks} ticks)`);
});

test('ordinary regex and plain-text searches still match', async () => {
  const r = await searchWorkspaceTool(ctx, { query: '^needle = \\d$', regex: true });
  assert.ok(r.ok && /app\.py:1: needle = 1/.test(r.text), r.ok ? r.text : r.message);
  const t = await searchWorkspaceTool(ctx, { query: 'needle = 1' });
  assert.ok(t.ok && /1 match\(es\) in 1 file/.test(t.text));
});

test('a listing cut at the editor limit is reported in the context report, not silently dropped', async () => {
  class HugePort extends FakePort {
    override async listFiles(): Promise<readonly string[]> {
      return Array.from({ length: LIST_LIMIT }, (_, i) => `data/f${i}.bin`);
    }
  }
  const index = await buildIndex(new HugePort(root));
  assert.ok(index.skipped.some((s) => s.path === '.' && /listing stopped at/.test(s.reason)));
});
