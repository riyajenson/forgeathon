import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { canonicalArgsKey, ReviewRegistry, sha256Hex } from '../review';
import { FakePort, normalizeWorkspacePath, startMcpServer, buildProposal, type AppliedEdit, type EditApproval, type RunningMcpServer, type ToolContext } from './index';

const HELPERS = [
  'def get_debug_flag() -> bool:',
  '    """Get whether debug mode should be enabled."""',
  '    val = os.environ.get("FLASK_DEBUG")',
  '    return bool(val and val.lower() not in {"0", "false", "no"})',
  '',
  'def get_load_dotenv(default: bool = True) -> bool:',
  '    return True',
  '',
].join('\n');

let root: string;
let port: FakePort;
let reviews: ReviewRegistry<EditApproval>;
let cancelled = false;
let applied: AppliedEdit[] = [];
let server: RunningMcpServer;
let client: Client;

const ctx: ToolContext = {
  get port() { return port; },
  get reviews() { return reviews; },
  isCancelled: () => cancelled,
  onApplied: (e) => { applied.push(e); },
};

async function call(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
  const r = await client.callTool({ name, arguments: args });
  const content = r.content as Array<{ type: string; text: string }>;
  return { isError: Boolean(r.isError), text: content.map((c) => c.text).join('') };
}

function errorCode(text: string): string {
  return (JSON.parse(text) as { error: { code: string } }).error.code;
}

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-mcp-'));
  port = new FakePort(root);
  reviews = new ReviewRegistry<EditApproval>();
  server = await startMcpServer({ context: ctx, port: 0 });
  client = new Client({ name: 'test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: { headers: { Authorization: `Bearer ${server.token}` } },
  }));
});

after(async () => {
  await client.close();
  await server.close();
  await fs.rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  cancelled = false;
  applied = [];
  port.writes.length = 0;
  reviews.clear();
  await fs.rm(path.join(root, 'src'), { recursive: true, force: true });
  await fs.rm(path.join(root, 'docs'), { recursive: true, force: true });
  await fs.mkdir(path.join(root, 'src/flask'), { recursive: true });
  await fs.writeFile(path.join(root, 'src/flask/helpers.py'), HELPERS);
  await fs.mkdir(path.join(root, 'docs'), { recursive: true });
  await fs.writeFile(path.join(root, 'docs/cli.rst'), 'Built-in commands\n=================\n\nflask routes\n');
});

function rawRequest(headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.port, path: '/mcp', method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end('{"jsonrpc":"2.0","id":1,"method":"tools/list"}');
  });
}

test('server binds 127.0.0.1 and rejects missing/wrong token and foreign Host', async () => {
  assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  assert.equal(await rawRequest({}), 401);
  assert.equal(await rawRequest({ authorization: 'Bearer nope' }), 401);
  assert.equal(await rawRequest({ authorization: `Bearer ${server.token}`, host: `evil.example:${server.port}` }), 403);
});

test('tools/list exposes the three tools with read-only annotations on the readers', async () => {
  const { tools } = await client.listTools();
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  assert.deepEqual(Object.keys(byName).sort(), ['propose_edit', 'read_file', 'search_workspace']);
  assert.equal(byName['read_file']!.annotations?.readOnlyHint, true);
  assert.equal(byName['search_workspace']!.annotations?.readOnlyHint, true);
  assert.equal(byName['propose_edit']!.annotations?.readOnlyHint, false);
});

test('read_file returns sha256 and numbered lines, honours ranges', async () => {
  const full = await call('read_file', { path: 'src/flask/helpers.py' });
  assert.equal(full.isError, false);
  assert.match(full.text, new RegExp(`sha256: ${sha256Hex(HELPERS)}`));
  assert.match(full.text, /lines: 7 \(showing 1-7\)/);
  assert.match(full.text, /\n1\tdef get_debug_flag\(\) -> bool:/);
  const part = await call('read_file', { path: './src/flask/helpers.py', start_line: 3, end_line: 4 });
  assert.match(part.text, /showing 3-4/);
  assert.doesNotMatch(part.text, /get_load_dotenv/);
});

test('read_file errors: missing file, outside workspace', async () => {
  const missing = await call('read_file', { path: 'nope.py' });
  assert.equal(missing.isError, true);
  assert.equal(errorCode(missing.text), 'FILE_NOT_FOUND');
  for (const bad of ['../etc/passwd', '/etc/passwd', 'C:/x.py', '.git/config', 'node_modules/a.js']) {
    const r = await call('read_file', { path: bad });
    assert.equal(errorCode(r.text), 'OUTSIDE_WORKSPACE', bad);
  }
});

test('search_workspace: text, regex, prefix', async () => {
  const text = await call('search_workspace', { query: 'FLASK_DEBUG' });
  assert.match(text.text, /^1 match\(es\) in 1 file/);
  assert.match(text.text, /src\/flask\/helpers\.py:3: val = os\.environ\.get\("FLASK_DEBUG"\)/);
  const regex = await call('search_workspace', { query: '^def get_\\w+', regex: true });
  assert.match(regex.text, /^2 match\(es\)/);
  const prefixed = await call('search_workspace', { query: 'flask', path_prefix: 'docs' });
  assert.match(prefixed.text, /docs\/cli\.rst:4: flask routes/);
  assert.doesNotMatch(prefixed.text, /src\//);
  const bad = await call('search_workspace', { query: '(', regex: true });
  assert.equal(errorCode(bad.text), 'INVALID_ARGS');
});

const twoHunkArgs = () => ({
  path: 'src/flask/helpers.py',
  base_sha256: sha256Hex(HELPERS),
  edits: [
    { old_text: '{"0", "false", "no"}', new_text: '{"0", "false", "no", "off", "n"}' },
    { old_text: '    return True\n', new_text: '    return default\n' },
  ],
  summary: 'test',
});

async function disk(rel: string): Promise<string> {
  return fs.readFile(path.join(root, rel), 'utf8');
}

test('propose_edit without a review decision writes nothing (NO_REVIEW_DECISION)', async () => {
  const r = await call('propose_edit', twoHunkArgs());
  assert.equal(r.isError, true);
  assert.equal(errorCode(r.text), 'NO_REVIEW_DECISION');
  assert.equal(await disk('src/flask/helpers.py'), HELPERS);
  assert.equal(port.writes.length, 0);
});

test('propose_edit applies only accepted hunks, once, and reports the rest', async () => {
  const args = twoHunkArgs();
  const built = await buildProposal(port, args);
  assert.ok(built.ok);
  if (!built.ok) return;
  assert.equal(built.proposal.hunks.length, 2);
  // Record with keys in a different order to prove canonical matching.
  reviews.record(canonicalArgsKey({ summary: args.summary, edits: args.edits, base_sha256: args.base_sha256, path: args.path }), {
    proposalId: 'call_1', baseSha256: built.proposal.baseSha256, accepted: [0], rejectReason: 'keep return True',
  });
  const r = await call('propose_edit', args);
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /Applied hunks \[0\] of 2/);
  assert.match(r.text, /Rejected hunks \[1\] were NOT applied \(user said: keep return True\)/);
  const after1 = await disk('src/flask/helpers.py');
  assert.match(after1, /"off", "n"/);
  assert.match(after1, /return True/);
  assert.equal(applied.length, 1);
  assert.deepEqual({ a: applied[0]!.applied, r: applied[0]!.rejected, pre: applied[0]!.preText }, { a: [0], r: [1], pre: HELPERS });

  // The decision was consumed: an identical second call does not write again.
  const again = await call('propose_edit', args);
  assert.equal(errorCode(again.text), 'NO_REVIEW_DECISION');
  assert.equal(port.writes.length, 1);
});

test('propose_edit refuses when the file changed after review (STALE_BASE)', async () => {
  const args = twoHunkArgs();
  reviews.record(canonicalArgsKey(args), { proposalId: 'call_2', baseSha256: sha256Hex(HELPERS), accepted: [0, 1] });
  await fs.writeFile(path.join(root, 'src/flask/helpers.py'), HELPERS.replace('Get whether', 'Decide whether'));
  const r = await call('propose_edit', args);
  assert.equal(errorCode(r.text), 'STALE_BASE');
  assert.equal(port.writes.length, 0);
});

test('propose_edit refuses after cancellation (CANCELLED)', async () => {
  const args = twoHunkArgs();
  reviews.record(canonicalArgsKey(args), { proposalId: 'call_3', baseSha256: sha256Hex(HELPERS), accepted: [0, 1] });
  cancelled = true;
  const r = await call('propose_edit', args);
  assert.equal(errorCode(r.text), 'CANCELLED');
  assert.equal(await disk('src/flask/helpers.py'), HELPERS);
});

test('propose_edit surfaces matching errors and all-rejected without writing', async () => {
  const notFound = { ...twoHunkArgs(), edits: [{ old_text: 'no such text', new_text: 'x' }] };
  reviews.record(canonicalArgsKey(notFound), { proposalId: 'call_4', baseSha256: sha256Hex(HELPERS), accepted: [0] });
  assert.equal(errorCode((await call('propose_edit', notFound)).text), 'OLD_TEXT_NOT_FOUND');

  const args = twoHunkArgs();
  reviews.record(canonicalArgsKey(args), { proposalId: 'call_5', baseSha256: sha256Hex(HELPERS), accepted: [], rejectReason: 'no' });
  assert.equal(errorCode((await call('propose_edit', args)).text), 'ALL_HUNKS_REJECTED');
  assert.equal(port.writes.length, 0);
});

test('propose_edit creates a new file with base_sha256 ""', async () => {
  const args = { path: 'tests/test_new.py', base_sha256: '', edits: [{ old_text: '', new_text: 'def test_x():\n    pass\n' }] };
  const built = await buildProposal(port, args);
  assert.ok(built.ok && built.proposal.isNewFile);
  reviews.record(canonicalArgsKey(args), { proposalId: 'call_6', baseSha256: null, accepted: [0] });
  const r = await call('propose_edit', args);
  assert.equal(r.isError, false, r.text);
  assert.equal(await disk('tests/test_new.py'), 'def test_x():\n    pass\n');
  assert.equal(applied[0]!.preText, null);
  await fs.rm(path.join(root, 'tests'), { recursive: true });
});

test('normalizeWorkspacePath', () => {
  assert.equal(normalizeWorkspacePath('./src//flask/../x'), null);
  assert.equal(normalizeWorkspacePath('src\\flask\\cli.py'), 'src/flask/cli.py');
  assert.equal(normalizeWorkspacePath('./src/./flask/cli.py'), 'src/flask/cli.py');
  assert.equal(normalizeWorkspacePath(''), null);
  assert.equal(normalizeWorkspacePath(42), null);
});
