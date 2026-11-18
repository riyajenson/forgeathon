// Runs the real setup (agent/*.json templates) against TrueForge with mock-backed custom providers,
// then rehearses an inline edit (Task A shape) headlessly through forge-inline.
import { repoRoot } from '../repo-root';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createHarness } from '../harness';
import { PROTOCOL_VERSION, type HarnessEvent } from '../contract-types';
import { FakePort } from '../mcp/fake-port';
import { runSetup, type AgentTemplate, type ModelsConfig } from '../setup/setup';
import { createClient } from '../trueforge/sdk';
import { MockModel, MOCK_KEY, textOf, type MockRequest } from '../testing/mock-model';

const TF_URL = process.env['TF_URL'] ?? 'http://127.0.0.1:8790';
const repo = repoRoot();
const templates: AgentTemplate[] = readdirSync(path.join(repo, 'agent')).filter((f) => f.endsWith('.json')).sort()
  .map((f) => JSON.parse(readFileSync(path.join(repo, 'agent', f), 'utf8')) as AgentTemplate);
const mock = new MockModel();
const HELPERS = 'def get_debug_flag() -> bool:\n    """Get whether debug mode should be enabled."""\n    val = os.environ.get("FLASK_DEBUG")\n    return bool(val and val.lower() not in {"0", "false", "no"})\n';

const cfg = (port: number): ModelsConfig => ({
  providers: [
    { type: 'custom', name: 'setup-primary', baseUrl: `http://127.0.0.1:${port}/v1`, apiKeyEnv: 'SETUP_IT_KEY', models: [{ name: 'pm', modelId: 'mock-primary', contextLength: 128000, maxOutputTokens: 4096 }] },
    { type: 'custom', name: 'setup-fallback', baseUrl: `http://127.0.0.1:${port}/v1`, apiKeyEnv: 'SETUP_IT_KEY', models: [{ name: 'fm', modelId: 'mock-fallback', contextLength: 128000, maxOutputTokens: 4096 }] },
  ],
  agents: { primaryModel: 'setup-primary/pm', fallbackModel: 'setup-fallback/fm' },
  connector: { name: 'vscode' },
});

before(async () => {
  await mock.start(0);
});

after(async () => {
  await mock.stop();
});

test('setup is idempotent and registers primary and fallback agents from the templates', async () => {
  const { client } = await createClient(TF_URL);
  const lines: string[] = [];
  const first = await runSetup({ client, cfg: cfg(mock.port), templates, env: { SETUP_IT_KEY: MOCK_KEY }, log: (l) => lines.push(l) });
  assert.deepEqual(first.missingModels, []);
  const second = await runSetup({ client, cfg: cfg(mock.port), templates, env: { SETUP_IT_KEY: MOCK_KEY }, log: (l) => lines.push(l) });
  assert.ok(second.agents.every((a) => a.action === 'updated'));
  assert.doesNotMatch(lines.join('\n'), new RegExp(MOCK_KEY));
  for (const [name, model] of [['forge-coder', 'setup-primary/pm'], ['forge-coder-fallback', 'setup-fallback/fm'], ['forge-inline', 'setup-primary/pm'], ['forge-inline-fallback', 'setup-fallback/fm']]) {
    const page = await client.agents.list({ agentName: name! });
    const agent = page.data.find((a) => a.name === name);
    assert.ok(agent, `${name} exists`);
    assert.equal(agent!.manifest.model.name, model);
  }
});

test('Task A rehearsal (headless): inline selection → one reviewed propose_edit → saved', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-inline-'));
  await fs.mkdir(path.join(root, 'src/flask'), { recursive: true });
  await fs.writeFile(path.join(root, 'src/flask/helpers.py'), HELPERS);
  let toolsSeen: string[] = [];
  mock.handler = (req: MockRequest) => {
    toolsSeen = req.toolNames;
    const last = req.messages[req.messages.length - 1];
    if (last?.role === 'tool') return { text: 'Treated off and n as false and listed all false values in the docstring.' };
    const user = req.messages.filter((m) => m.role === 'user').map((m) => textOf(m.content)).join('\n');
    const sha = /file sha256: ([0-9a-f]{64})/.exec(user)?.[1] ?? 'missing';
    return {
      toolCalls: [{
        name: 'propose_edit',
        args: {
          path: 'src/flask/helpers.py', base_sha256: sha, summary: 'treat off and n as false',
          edits: [
            { old_text: '    """Get whether debug mode should be enabled."""', new_text: '    """Get whether debug mode should be enabled.\n\n    ``"0"``, ``"false"``, ``"no"``, ``"off"`` and ``"n"`` (any case) are false.\n    """' },
            { old_text: '{"0", "false", "no"}', new_text: '{"0", "false", "no", "off", "n"}' },
          ],
        },
      }],
    };
  };
  const port = new FakePort(root);
  const h = createHarness({ trueforgeUrl: TF_URL, mcpPort: 0 });
  await h.start(port);
  try {
    const s = await h.createSession({ version: PROTOCOL_VERSION, requestId: 'r1', body: { workspaceRoot: root } });
    assert.ok(s.ok);
    const sessionId = s.ok ? s.body.sessionId : '';
    const turnId = 'inline-1';
    const sub = await h.submitTurn({
      version: PROTOCOL_VERSION, requestId: 'r2',
      body: {
        sessionId, turnId, mode: 'inline',
        instruction: "Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.",
        selection: { path: 'src/flask/helpers.py', startLine: 1, endLine: 4, text: HELPERS.trimEnd() },
      },
    });
    assert.ok(sub.ok, JSON.stringify(sub));
    const events: HarnessEvent[] = [];
    for await (const r of h.stream({ version: PROTOCOL_VERSION, requestId: 'r3', body: { sessionId, turnId, afterSequence: 0 } })) {
      assert.ok(r.ok);
      if (!r.ok) break;
      events.push(r.body);
      if (r.body.t === 'review_request') {
        const p = r.body.proposal;
        assert.equal(p.hunks.length, 2);
        const d = await h.submitReview({ version: PROTOCOL_VERSION, requestId: 'r4', body: { sessionId, turnId, callId: p.callId, kind: 'edit', proposalId: p.proposalId, hunks: Object.fromEntries(p.hunks.map((x) => [x.hunkId, 'accept'])) } });
        assert.ok(d.ok);
      }
    }
    assert.equal(events[events.length - 1]!.t, 'done');
    assert.equal((events[events.length - 1] as Extract<HarnessEvent, { t: 'done' }>).status, 'done');
    const session = events.find((e): e is Extract<HarnessEvent, { t: 'session' }> => e.t === 'session')!;
    assert.equal(session.agentName, 'forge-inline');
    assert.equal(session.model, 'setup-primary/pm');
    assert.deepEqual([...toolsSeen].filter((n) => ['read_file', 'propose_edit', 'search_workspace', 'run_command'].includes(n)).sort(), ['propose_edit', 'read_file'], 'inline agent exposes only read_file and propose_edit');
    const after = await fs.readFile(path.join(root, 'src/flask/helpers.py'), 'utf8');
    assert.match(after, /"off", "n"/);
    assert.match(after, /``"off"`` and ``"n"`` \(any case\) are false/);
  } finally {
    await h.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});
