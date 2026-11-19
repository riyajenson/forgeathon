// One policy for every source of model-bound text: credentials files are refused whether they arrive through
// automatic retrieval, @file, the selection, the prompt fallback, read_file, search_workspace, list_files,
// find_symbol or gather_context; binary content is refused and long output is capped with a marker.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { FakePort, READ_FILE_MAX_CHARS, readFileTool, searchWorkspaceTool, SEARCH_MAX_OUTPUT_CHARS, type ToolContext } from './index';
import { findSymbolTool, listFilesTool } from './symbol-tools';
import { gatherContextTool } from './context-tool';
import { assembleContext } from '../context';
import { MAX_LINE_CHARS } from '../context/files';
import { buildTurnInput } from '../turn/prompt';
import type { TurnRequest } from '../contract-types';

const SECRET = 'SUPERSECRET_marker_9f3c';
let root: string;
let ctx: ToolContext;

const FILES: Record<string, string> = {
  'app.py': 'def handler():\n    return "needle"\n',
  '.env': `API_KEY=${SECRET}\n`,
  'deploy/server.pem': `-----BEGIN ${SECRET}-----\n`,
  'blob.py': 'needle = 1\0\0\0\n',
  'long.txt': `needle ${'x'.repeat(MAX_LINE_CHARS * 3)}\n`,
  'many.txt': Array.from({ length: 500 }, (_, i) => `line ${i} ${'y'.repeat(400)}`).join('\n') + '\n',
  'hits.txt': Array.from({ length: 200 }, (_, i) => `needle ${i} ${'z'.repeat(400)}`).join('\n') + '\n',
};

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-policy-'));
  for (const [rel, text] of Object.entries(FILES)) {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), text);
  }
  ctx = { port: new FakePort(root), scope: undefined };
});
after(async () => { await fs.rm(root, { recursive: true, force: true }); });

const req = (over: Partial<TurnRequest>): TurnRequest => ({
  protocolVersion: '0.4.4', sessionId: 's', turnId: 't', mode: 'agent', instruction: 'fix the handler', ...over,
} as unknown as TurnRequest);

test('@file mentions and references of credentials files are refused with a visible reason', async () => {
  const r = await assembleContext(ctx.port, {
    instruction: 'use @file:.env please', references: [{ kind: 'file', path: 'deploy/server.pem' }], budgetTokens: 8000, mode: 'agent',
  });
  assert.ok(!r.text.includes(SECRET), 'credentials content reached the context');
  assert.ok(!r.report.selections.some((s) => s.path === '.env' || s.path === 'deploy/server.pem'));
  for (const p of ['.env', 'deploy/server.pem']) {
    assert.ok(r.report.skipped.some((s) => s.path === p && /credentials file; its content is never sent/.test(s.reason)), p);
  }
});

test('a selection in a credentials file is not sent, including the prompt fallback when context assembly fails', async () => {
  const selection = { path: '.env', startLine: 1, endLine: 1, text: `API_KEY=${SECRET}` };
  const r = await assembleContext(ctx.port, { instruction: 'edit', selection, budgetTokens: 8000, mode: 'inline' });
  assert.ok(!r.text.includes(SECRET));
  assert.ok(r.report.skipped.some((s) => s.path === '.env' && /selection not sent/.test(s.reason)));

  const ok = await buildTurnInput(req({ mode: 'inline', selection } as Partial<TurnRequest>), ctx.port, 8000);
  assert.ok(!ok.input.includes(SECRET) && /not sent: \.env looks like a credentials file/.test(ok.input), ok.input);

  class BrokenPort extends FakePort { override async listFiles(): Promise<readonly string[]> { throw new Error('listing failed'); } }
  const fallback = await buildTurnInput(req({ mode: 'inline', selection } as Partial<TurnRequest>), new BrokenPort(root), 8000);
  assert.ok(!fallback.input.includes(SECRET), 'the error fallback leaked the selection');
  const plain = await buildTurnInput(req({ mode: 'inline', selection: { path: 'app.py', startLine: 1, endLine: 2, text: 'def handler():' } } as Partial<TurnRequest>), new BrokenPort(root), 8000);
  assert.ok(plain.input.includes('def handler():'), 'an ordinary selection still reaches the model when assembly fails');
});

test('gather_context and the tools refuse credentials files; listing and search never show them', async () => {
  const g = await gatherContextTool(ctx, { task: 'look at @file:.env' });
  assert.ok(g.ok && !g.text.includes(SECRET));
  for (const p of ['.env', 'deploy/server.pem']) {
    const r = await readFileTool(ctx, { path: p });
    assert.ok(!r.ok && r.code === 'SECRET_FILE' && /never sent to the model/.test(r.message), p);
  }
  const s = await searchWorkspaceTool(ctx, { query: SECRET });
  assert.ok(s.ok && /^0 match/.test(s.text) && !s.text.includes('.env'), s.ok ? s.text : s.message);
  const l = await listFilesTool(ctx, {});
  assert.ok(l.ok && !/\.env|server\.pem/.test(l.text));
});

test('read_file refuses binary content and caps long lines and total characters with a marker', async () => {
  const bin = await readFileTool(ctx, { path: 'blob.py' });
  assert.ok(!bin.ok && bin.code === 'BINARY_FILE', 'binary content was returned');

  const long = await readFileTool(ctx, { path: 'long.txt' });
  assert.ok(long.ok && /\[line truncated: \d+ characters\]/.test(long.text));
  assert.ok(long.ok && long.text.length < MAX_LINE_CHARS + 500, `one long line returned ${long.ok ? long.text.length : 0} characters`);

  const many = await readFileTool(ctx, { path: 'many.txt' });
  assert.ok(many.ok);
  if (!many.ok) return;
  assert.ok(many.text.length <= READ_FILE_MAX_CHARS + 500, `returned ${many.text.length} characters`);
  const next = /\[truncated at \d+ characters: call read_file with start_line=(\d+) for more\]/.exec(many.text);
  assert.ok(next, 'no continuation marker');
  const rest = await readFileTool(ctx, { path: 'many.txt', start_line: Number(next[1]) });
  assert.ok(rest.ok && rest.text.includes(`line ${Number(next[1]) - 1} `), 'the continuation starts where the first read stopped');
});

test('search skips binary files (and says so) and caps its total output', async () => {
  const s = await searchWorkspaceTool(ctx, { query: 'needle', max_results: 200 });
  assert.ok(s.ok);
  if (!s.ok) return;
  assert.ok(!s.text.includes('blob.py'), 'binary file searched');
  assert.ok(/binary or oversized file\(s\) not searched/.test(s.text));
  assert.ok(s.text.length <= SEARCH_MAX_OUTPUT_CHARS + 1000, `returned ${s.text.length} characters`);
});

test('an unreadable .gitignore stops listing, search and symbol lookup with a clear reason', async () => {
  class NoIgnorePort extends FakePort {
    override async readText(rel: string) {
      if (rel === '.gitignore') throw new Error('permission denied');
      return super.readText(rel);
    }
  }
  const c: ToolContext = { port: new NoIgnorePort(root), scope: undefined };
  for (const r of [await listFilesTool(c, {}), await searchWorkspaceTool(c, { query: 'needle' }), await findSymbolTool(c, { name: 'handler' })]) {
    assert.ok(!r.ok && r.code === 'POLICY_UNAVAILABLE' && /cannot read \.gitignore/.test(r.message), r.ok ? r.text : r.message);
  }
});

test('a pinned selection or @file that does not fit the budget is reported as skipped, and accounting stays exact', async () => {
  const selection = { path: 'app.py', startLine: 1, endLine: 2, text: FILES['app.py']! };
  for (const budget of [1, 10]) {
    const r = await assembleContext(ctx.port, { instruction: 'x', selection, budgetTokens: budget, mode: 'inline' });
    assert.ok(r.report.skipped.some((s) => s.path === 'app.py' && /does not fit/.test(s.reason)), `budget ${budget}`);
  }
  const f = await assembleContext(ctx.port, { instruction: 'x @file:many.txt', budgetTokens: 1, mode: 'agent' });
  assert.ok(f.report.skipped.some((s) => s.path === 'many.txt' && /does not fit/.test(s.reason)));
  const huge = await assembleContext(ctx.port, { instruction: 'x', selection, budgetTokens: 1e20, mode: 'inline' });
  const sum = huge.report.selections.reduce((n, s) => n + s.estimatedTokens, 0);
  assert.ok(sum > 0 && huge.report.estimatedTokens === sum, `${huge.report.estimatedTokens} vs ${sum}`);
});
