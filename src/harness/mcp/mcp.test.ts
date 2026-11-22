import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ApplyTextResult, CallRef } from '../contract-types';
import { sha256Hex } from '../review';
import {
  approvalKey, buildProposal, FakePort, hunkId, normalizeWorkspacePath, ScopeRegistry, SESSION_HEADER, startMcpServer,
  type EditApproval, type RunningMcpServer, type SessionScope,
} from './index';

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

const TF_SESSION = 'tf-session-1';
let root: string;
let port: FakePort;
let scopes: ScopeRegistry;
let scope: SessionScope;
let applied: ApplyTextResult[] = [];
let server: RunningMcpServer;
const clients: Client[] = [];

async function connect(runtimeSessionId: string | undefined): Promise<Client> {
  const headers: Record<string, string> = { Authorization: `Bearer ${server.token}` };
  if (runtimeSessionId) headers[SESSION_HEADER] = runtimeSessionId;
  const c = new Client({ name: 'test', version: '0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers } }));
  clients.push(c);
  return c;
}

let client: Client;

async function call(name: string, args: Record<string, unknown>, via: Client = client): Promise<{ isError: boolean; text: string }> {
  const r = await via.callTool({ name, arguments: args });
  const content = r.content as Array<{ type: string; text: string }>;
  return { isError: Boolean(r.isError), text: content.map((c) => c.text).join('') };
}

function errorCode(text: string): string {
  return (JSON.parse(text) as { error: { code: string } }).error.code;
}

const callRef = (callId: string): CallRef => ({ sessionId: 'app-s', turnId: 'app-t', callId });

function approve(args: unknown, callId: string, accepted: number[], baseSha256: string | null = sha256Hex(HELPERS), into: SessionScope = scope, rejectReason?: string): void {
  const approval: EditApproval = {
    callRef: callRef(callId), proposalId: callId, baseSha256,
    acceptedIndices: accepted, acceptedHunkIds: accepted.map((i) => hunkId(callId, i)),
    ...(rejectReason ? { rejectReason } : {}),
  };
  into.reviews.record(approvalKey('propose_edit', args), approval);
}

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-mcp-'));
  port = new FakePort(root);
  scopes = new ScopeRegistry();
  server = await startMcpServer({ port, scopes, listenPort: 0 });
  client = await connect(TF_SESSION);
});

after(async () => {
  for (const c of clients) await c.close();
  await server.close();
  await fs.rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  scopes.closeAll();
  scope = scopes.open(TF_SESSION);
  applied = [];
  scope.onApplied = (r) => { applied.push(r); };
  port.applies.length = 0;
  port.mode = 'save';
  port.formatOnSave = undefined;
  for (const dir of ['src', 'docs', 'tests']) await fs.rm(path.join(root, dir), { recursive: true, force: true });
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

async function disk(rel: string): Promise<string> {
  return fs.readFile(path.join(root, rel), 'utf8');
}

const twoHunkArgs = () => ({
  path: 'src/flask/helpers.py',
  base_sha256: sha256Hex(HELPERS),
  edits: [
    { old_text: '{"0", "false", "no"}', new_text: '{"0", "false", "no", "off", "n"}' },
    { old_text: '    return True\n', new_text: '    return default\n' },
  ],
  summary: 'test',
});

test('server binds 127.0.0.1 and rejects missing/wrong token and foreign Host', async () => {
  assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  assert.equal(await rawRequest({}), 401);
  assert.equal(await rawRequest({ authorization: 'Bearer nope' }), 401);
  assert.equal(await rawRequest({ authorization: `Bearer ${server.token}`, host: `evil.example:${server.port}` }), 403);
});

test('approvalKey ignores keys the MCP server would strip', () => {
  const args = twoHunkArgs();
  const noisy = { ...args, explanation: 'extra', edits: args.edits.map((e) => ({ ...e, why: 'x' })) };
  assert.equal(approvalKey('propose_edit', noisy), approvalKey('propose_edit', args));
  assert.notEqual(approvalKey('propose_edit', { ...args, path: 'other.py' }), approvalKey('propose_edit', args));
  assert.equal(approvalKey('run_command', { command: 'ls', note: 1 }), approvalKey('run_command', { command: 'ls' }));
});

test('tools/list exposes the five tools with read-only annotations on the readers', async () => {
  const { tools } = await client.listTools();
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  assert.deepEqual(Object.keys(byName).sort(), ['find_symbol', 'gather_context', 'list_files', 'propose_edit', 'read_file', 'run_command', 'search_workspace']);
  assert.equal(byName['find_symbol']!.annotations?.readOnlyHint, true);
  assert.equal(byName['list_files']!.annotations?.readOnlyHint, true);
  assert.equal(byName['gather_context']!.annotations?.readOnlyHint, true);
  assert.equal(byName['run_command']!.annotations?.destructiveHint, true);
  // A real model (2026-11-19) guessed `cd /workspace && …`; the description says where commands start.
  assert.match(byName['run_command']!.description ?? '', /starts in the workspace root.*workspace-relative paths/);
  assert.equal(byName['read_file']!.annotations?.readOnlyHint, true);
  assert.equal(byName['search_workspace']!.annotations?.readOnlyHint, true);
  assert.equal(byName['propose_edit']!.annotations?.readOnlyHint, false);
  // Multi-range reads are off by default: the model sees the read_file schema unchanged.
  assert.equal(Object.keys((byName['read_file']!.inputSchema as { properties: object }).properties).includes('ranges'), false);
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

test('read tools mask credential-shaped strings before the model sees them; the file and its sha256 are unchanged', async () => {
  const key = 'nvapi-' + 'K'.repeat(30);
  const text = `import os\nNVIDIA = "${key}"\nSECRET_KEY = "dev-value-123456"\n`;
  await fs.mkdir(path.join(root, 'conf'), { recursive: true });
  await fs.writeFile(path.join(root, 'conf', 'local_settings.py'), text);
  const read = await call('read_file', { path: 'conf/local_settings.py' });
  assert.equal(read.isError, false);
  assert.ok(!read.text.includes(key), 'the key never reaches the model');
  assert.match(read.text, /2\tNVIDIA = "\[REDACTED\]"/);
  assert.match(read.text, /3\tSECRET_KEY = "dev-value-123456"/, 'ordinary code is unchanged');
  assert.match(read.text, new RegExp(`sha256: ${sha256Hex(text)}`), 'the hash is of the real file');
  assert.match(read.text, /\[Forge masked 1 credential-shaped string in this text; the file itself is unchanged\]$/);
  const found = await call('search_workspace', { query: 'NVIDIA', path_prefix: 'conf' });
  assert.ok(!found.text.includes(key));
  assert.match(found.text, /\[REDACTED\]/);
  assert.equal(await fs.readFile(path.join(root, 'conf', 'local_settings.py'), 'utf8'), text);
  await fs.rm(path.join(root, 'conf'), { recursive: true, force: true });
});

test('read_file errors: missing file, outside workspace', async () => {
  assert.equal(errorCode((await call('read_file', { path: 'nope.py' })).text), 'FILE_NOT_FOUND');
  for (const bad of ['../etc/passwd', '/etc/passwd', 'C:/x.py', '.git/config', 'node_modules/a.js']) {
    assert.equal(errorCode((await call('read_file', { path: bad })).text), 'OUTSIDE_WORKSPACE', bad);
  }
});

test('search_workspace: text, regex, prefix', async () => {
  const text = await call('search_workspace', { query: 'FLASK_DEBUG' });
  assert.match(text.text, /^1 match\(es\) in 1 file/);
  assert.match(text.text, /src\/flask\/helpers\.py:3: val = os\.environ\.get\("FLASK_DEBUG"\)/);
  assert.match((await call('search_workspace', { query: '^def get_\\w+', regex: true })).text, /^2 match\(es\)/);
  const prefixed = await call('search_workspace', { query: 'flask', path_prefix: 'docs' });
  assert.match(prefixed.text, /docs\/cli\.rst:4: flask routes/);
  assert.doesNotMatch(prefixed.text, /src\//);
  assert.equal(errorCode((await call('search_workspace', { query: '(', regex: true })).text), 'INVALID_ARGS');
});

test('deferred tools: find_symbol (exact, qualified, fuzzy) and list_files', async () => {
  const exact = await call('find_symbol', { name: 'get_debug_flag' });
  assert.match(exact.text, /^1 definition\(s\) of "get_debug_flag":\nsrc\/flask\/helpers\.py:1-4  function get_debug_flag: def get_debug_flag\(\) -> bool:/);
  const fuzzy = await call('find_symbol', { name: 'dotenv' });
  assert.match(fuzzy.text, /names containing "dotenv"/);
  assert.match(fuzzy.text, /get_load_dotenv/);
  assert.match((await call('find_symbol', { name: 'nothing_here' })).text, /No Python definition/);
  const all = await call('list_files', {});
  assert.match(all.text, /docs\/cli\.rst\nsrc\/flask\/helpers\.py/);
  const docs = await call('list_files', { prefix: 'docs' });
  assert.match(docs.text, /^1 file\(s\) under docs:\ndocs\/cli\.rst$/);
  assert.equal(errorCode((await call('list_files', { prefix: '../x' })).text), 'OUTSIDE_WORKSPACE');
});

test('propose_edit without a review decision writes nothing (NO_REVIEW_DECISION)', async () => {
  const r = await call('propose_edit', twoHunkArgs());
  assert.equal(r.isError, true);
  assert.equal(errorCode(r.text), 'NO_REVIEW_DECISION');
  assert.equal(await disk('src/flask/helpers.py'), HELPERS);
  assert.equal(port.applies.length, 0);
});

test('an approval in one TrueForge session cannot be used by another session or an unbound call', async () => {
  const args = twoHunkArgs();
  approve(args, 'call_x', [0, 1]);
  const other = scopes.open('tf-session-2');
  other.onApplied = (r) => { applied.push(r); };
  assert.equal(errorCode((await call('propose_edit', args, await connect('tf-session-2'))).text), 'NO_REVIEW_DECISION');
  assert.equal(errorCode((await call('propose_edit', args, await connect(undefined))).text), 'NO_REVIEW_DECISION');
  assert.equal(port.applies.length, 0);
  assert.equal(scope.reviews.size, 1, 'the approval stays with its own session');
});

test('propose_edit sends the reviewed text (R5), applies only accepted hunks, once', async () => {
  const args = twoHunkArgs();
  const built = await buildProposal(port, args);
  assert.ok(built.ok);
  if (!built.ok) return;
  assert.equal(built.proposal.hunks.length, 2);
  // Record with keys in a different order to prove canonical matching.
  approve({ summary: args.summary, edits: args.edits, base_sha256: args.base_sha256, path: args.path }, 'call_1', [0], built.proposal.baseSha256, scope, 'keep return True');
  const r = await call('propose_edit', args);
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /Applied hunks \[0\] of 2/);
  assert.match(r.text, /Rejected hunks \[1\] were NOT applied \(user said: keep return True\)/);
  assert.match(r.text, /Saved\. New sha256: [0-9a-f]{64}$/);
  const after1 = await disk('src/flask/helpers.py');
  assert.match(after1, /"off", "n"/);
  assert.match(after1, /return True/);

  assert.equal(port.applies.length, 1);
  const req = port.applies[0]!;
  assert.deepEqual([req.kind, req.proposalId, req.acceptedHunkIds, req.expectedSha256, req.callId], ['apply_approved', 'call_1', ['call_1#0'], sha256Hex(HELPERS), 'call_1']);
  assert.equal(req.text, after1);
  assert.equal(req.textSha256, sha256Hex(after1));
  assert.equal(applied.length, 1);
  assert.equal(applied[0]!.status, 'saved');
  assert.equal(scope.writes, 1);

  assert.equal(errorCode((await call('propose_edit', args)).text), 'NO_REVIEW_DECISION', 'decision is used once');
  assert.equal(port.applies.length, 1);
});

test('propose_edit refuses when the file changed after review (STALE_BASE)', async () => {
  const args = twoHunkArgs();
  approve(args, 'call_2', [0, 1]);
  await fs.writeFile(path.join(root, 'src/flask/helpers.py'), HELPERS.replace('Get whether', 'Decide whether'));
  assert.equal(errorCode((await call('propose_edit', args)).text), 'STALE_BASE');
  assert.equal(port.applies.length, 0);
  assert.equal(scope.writes, 0);
});

test('cancel closes the gate and drops waiting approvals (CANCELLED)', async () => {
  const args = twoHunkArgs();
  approve(args, 'call_3', [0, 1]);
  scope.cancel();
  assert.equal(scope.reviews.size, 0);
  assert.equal(errorCode((await call('propose_edit', args)).text), 'CANCELLED');
  assert.equal(await disk('src/flask/helpers.py'), HELPERS);
});

test('propose_edit surfaces matching errors and all-rejected without writing', async () => {
  const notFound = { ...twoHunkArgs(), edits: [{ old_text: 'no such text', new_text: 'x' }] };
  approve(notFound, 'call_4', [0]);
  assert.equal(errorCode((await call('propose_edit', notFound)).text), 'OLD_TEXT_NOT_FOUND');
  const args = twoHunkArgs();
  approve(args, 'call_5', [], sha256Hex(HELPERS), scope, 'no');
  assert.equal(errorCode((await call('propose_edit', args)).text), 'ALL_HUNKS_REJECTED');
  assert.equal(port.applies.length, 0);
});

test('editor outcomes: deferred save, failed save, reformat on save, unknown outcome', async () => {
  const args = twoHunkArgs();
  port.mode = 'defer';
  approve(args, 'c_defer', [0]);
  const deferred = await call('propose_edit', args);
  assert.equal(deferred.isError, false);
  assert.match(deferred.text, /NOT saved \(document had unrelated unsaved changes\)/);
  assert.equal(scope.writes, 1);

  await fs.writeFile(path.join(root, 'src/flask/helpers.py'), HELPERS);
  port.mode = 'save_fail';
  approve(args, 'c_fail', [0]);
  assert.match((await call('propose_edit', args)).text, /saving failed \(disk full\)/);
  assert.equal(scope.writes, 2);

  await fs.writeFile(path.join(root, 'src/flask/helpers.py'), HELPERS);
  port.mode = 'save';
  port.formatOnSave = (t) => t.replace(/\n\n/g, '\n\n\n');
  approve(args, 'c_fmt', [0]);
  const fmt = await call('propose_edit', args);
  assert.match(fmt.text, /reformatted the file on save; read it again/);
  const savedSha = sha256Hex(await disk('src/flask/helpers.py'));
  assert.match(fmt.text, new RegExp(`New sha256: ${savedSha}`));
  const last = applied[applied.length - 1]!;
  assert.ok(last.status === 'saved' && last.undo.expectedPostSha256 === savedSha, 'undo guard uses the post-save hash');

  await fs.writeFile(path.join(root, 'src/flask/helpers.py'), HELPERS);
  port.formatOnSave = undefined;
  port.mode = 'throw';
  approve(args, 'c_throw', [0]);
  assert.equal(errorCode((await call('propose_edit', args)).text), 'WRITE_OUTCOME_UNKNOWN');
  assert.equal(scope.writes, 4, 'an unknown outcome counts as a write');
});

test('propose_edit creates a new file with base_sha256 ""', async () => {
  const args = { path: 'tests/test_new.py', base_sha256: '', edits: [{ old_text: '', new_text: 'def test_x():\n    pass\n' }] };
  const built = await buildProposal(port, args);
  assert.ok(built.ok && built.proposal.isNewFile);
  approve(args, 'call_6', [0], null);
  const r = await call('propose_edit', args);
  assert.equal(r.isError, false, r.text);
  assert.equal(await disk('tests/test_new.py'), 'def test_x():\n    pass\n');
  assert.equal(port.applies[0]!.expectedSha256, null);
});

test('scope tracks in-flight calls and settles', async () => {
  let release!: () => void;
  const slow = scope.track(new Promise<void>((r) => { release = r; }));
  assert.equal(scope.inFlightCount, 1);
  assert.equal(await scope.settle(20), false);
  release();
  await slow;
  assert.equal(await scope.settle(20), true);
});

test('normalizeWorkspacePath', () => {
  assert.equal(normalizeWorkspacePath('./src//flask/../x'), null);
  assert.equal(normalizeWorkspacePath('src\\flask\\cli.py'), 'src/flask/cli.py');
  assert.equal(normalizeWorkspacePath('./src/./flask/cli.py'), 'src/flask/cli.py');
  assert.equal(normalizeWorkspacePath(''), null);
  assert.equal(normalizeWorkspacePath(42), null);
});

test('propose_edit with edits sent as a JSON string (seen with a real model): reviewed, approved and applied like the array', async () => {
  const args = twoHunkArgs();
  const stringly = { ...args, edits: JSON.stringify(args.edits) };
  assert.equal(approvalKey('propose_edit', stringly), approvalKey('propose_edit', args), 'review and execution agree on the key');
  const built = await buildProposal(port, stringly as never);
  assert.ok(built.ok, 'the review is built from the string');
  if (!built.ok) return;
  assert.equal(built.proposal.hunks.length, 2);
  approve(stringly, 'call_s', [0, 1], built.proposal.baseSha256);   // the turn records the args as the model sent them
  const r = await call('propose_edit', stringly);                    // TrueForge forwards the same string
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /Applied hunks \[0, ?1\] of 2/);
});

test('propose_edit with an unparseable edits string is refused with a message that says what to send', async () => {
  const args = { ...twoHunkArgs(), edits: '[{"old_text": "x", "new_text": "y"' };   // cut off: not valid JSON
  const built = await buildProposal(port, args as never);
  assert.equal(built.ok, false);
  if (built.ok) return;
  assert.equal(built.code, 'INVALID_EDIT');
  assert.match(built.message, /JSON array of \{"old_text".*not a string|Pass the array itself/);
});

test('with multiRangeRead on, read_file offers ranges and a call returns several ranges with one hash', async () => {
  const s2 = await startMcpServer({ port, scopes, listenPort: 0, multiRangeRead: true });
  const c = new Client({ name: 'test', version: '0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(s2.url), { requestInit: { headers: { Authorization: `Bearer ${s2.token}` } } }));
  try {
    const { tools } = await c.listTools();
    const rf = tools.find((t) => t.name === 'read_file')!;
    assert.ok(Object.keys((rf.inputSchema as { properties: object }).properties).includes('ranges'));
    const r = await c.callTool({ name: 'read_file', arguments: { path: 'src/flask/helpers.py', ranges: [{ start_line: 1, end_line: 1 }, { start_line: 3, end_line: 3 }] } });
    const text = (r.content as Array<{ text: string }>)[0]!.text;
    assert.equal(r.isError ?? false, false, text);
    assert.match(text, /showing 1-1, 3-3/);
  } finally { await c.close(); await s2.close(); }
});
