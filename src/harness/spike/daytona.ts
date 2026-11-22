// Daytona spike (opt-in, harness/p15-daytona): TrueForge's sandbox provider, one git skill and Code Mode, driven by
// the scripted model through the real harness on a scratch workspace. Nothing here touches Tasks A, B or C or the
// default setup. The Daytona key comes from DAYTONA_API_KEY and is never printed: every line this script prints
// or records goes through redact() with the key.
//
//   scripts/daytona-spike.sh [OUT_DIR]     (starts its own TrueForge on :8792 and runs this file)
//
// One agent turn, scripted, in four sandbox steps:
//   1. exec: the sandbox runs (OS, Python, no home secrets);
//   2. exec: the git skill forge-flask-cli is mounted in the sandbox;
//   3. Code Mode: `mcp-client call-tool <connector> read_file` reads a workspace file through TrueForge and the harness;
//   4. Code Mode: `mcp-client call-tool <connector> propose_edit` must be refused (approval-gated tools are not
//      callable from the sandbox) and the file must stay unchanged.
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createHarness } from '../harness';
import { PROTOCOL_VERSION, type HarnessEvent } from '../contract-types';
import { FakePort } from '../mcp/fake-port';
import { redact } from '../mcp/redact';
import { sha256Hex } from '../review';
import { createClient } from '../trueforge/sdk';
import { MockModel, MOCK_KEY, textOf, type MockReply, type MockRequest } from '../testing/mock-model';

const TF_URL = process.env['TF_URL'] ?? 'http://127.0.0.1:8792';
const KEY = process.env['DAYTONA_API_KEY'] ?? '';
const MOCK_PORT = Number(process.env['SPIKE_MOCK_PORT'] ?? 47793);
const CONNECTOR = 'forge-spike-vscode';
const AGENT = 'forge-spike-daytona';
const ENVIRONMENT = 'forge-spike';
const SKILL = 'forge-flask-cli';
const SKILL_REF = process.env['SPIKE_SKILL_REF'] ?? 'harness/p15-daytona';
const FILE = 'src/app.py';
const ORIGINAL = 'def alpha():\n    return 1\n';

const clean = (s: string) => redact(s, KEY ? [KEY] : []).text;
const log = (s: string) => console.log(clean(s));
const arg = (name: string, fallback: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] ?? fallback : fallback; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Step { name: string; command: string }
const steps = (sha: string): Step[] => [
  { name: 'sandbox', command: 'uname -sm; python3 --version; echo "home=$HOME"; ls -A ~ | head -20; test -e ~/.ssh && echo HAS_SSH || echo NO_SSH' },
  { name: 'skill', command: `f=$(find / -path '*${SKILL}*' -name SKILL.md 2>/dev/null | head -1); echo "skill file: $f"; head -4 "$f"` },
  { name: 'codemode-read', command: `mcp-client call-tool ${CONNECTOR} read_file '${JSON.stringify({ path: FILE })}' 2>&1 | head -c 600` },
  { name: 'codemode-write', command: `mcp-client call-tool ${CONNECTOR} propose_edit '${JSON.stringify({ path: FILE, base_sha256: sha, edits: [{ old_text: '    return 1', new_text: '    return 2' }] })}' 2>&1 | head -c 600; echo; echo "exit=$?"` },
];

function script(all: Step[]) {
  return (req: MockRequest): MockReply => {
    const results = req.messages.filter((m) => m.role === 'tool').length;
    const step = all[results];
    if (!step) return { text: `spike finished after ${results} sandbox steps` };
    return { toolCalls: [{ name: 'exec', args: { intent: `spike step: ${step.name}`, command: step.command } }] };
  };
}

async function main(): Promise<void> {
  if (!KEY) throw new Error('DAYTONA_API_KEY is not set (scripts/daytona-spike.sh reads it from .env.daytona)');
  const out = path.resolve(arg('--out', path.join(os.homedir(), 'forge-review', 'finals', 'daytona-spike')));
  await fs.mkdir(out, { recursive: true });
  const t0 = Date.now();
  const at = () => `${((Date.now() - t0) / 1000).toFixed(1)} s`;
  const record: Record<string, unknown> = { startedAt: new Date(t0).toISOString(), trueforge: TF_URL, skillRef: SKILL_REF };

  const mock = new MockModel();
  await mock.start(MOCK_PORT);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-spike-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, FILE), ORIGINAL);
  mock.handler = script(steps(sha256Hex(ORIGINAL)));
  const { client } = await createClient(TF_URL);
  const h = createHarness({ trueforgeUrl: TF_URL, mcpPort: 0, connectorName: CONNECTOR, agents: { agent: AGENT, inline: AGENT }, watchdogMs: 300_000, modelWatchdogMs: 300_000 });
  try {
    // 1. Providers: the scripted model, and Daytona (key from the environment, write-only in TrueForge).
    await client.settings.modelProviders.createOrUpdate({ manifest: { type: 'custom', name: 'spikemock', baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`, auth: { apiKey: MOCK_KEY }, models: [{ name: 'primary', modelId: 'mock-primary', properties: { contextLength: 128000, maxOutputTokens: 2048 } }] } });
    await client.settings.sandboxProviders.createOrUpdate({ manifest: { type: 'daytona', auth: { apiKey: KEY }, autoStopIntervalInMinutes: 5, autoArchiveIntervalInMinutes: 60, autoDeleteIntervalInMinutes: 10, execTimeoutMs: 120_000 } });
    log(`[${at()}] Daytona sandbox provider registered (auto-stop 5 min, auto-delete 10 min after stop)`);

    // 2. Sandbox environment: TrueForge builds it into a Daytona snapshot; wait until it is ready.
    await client.sandboxEnvironments.createOrUpdate({ manifest: { name: ENVIRONMENT, description: 'Forge Daytona spike' } });
    const envStart = Date.now();
    let envStatus = 'pending';
    let envReason: string | null = null;
    while (Date.now() - envStart < 20 * 60_000) {
      const env = (await client.sandboxEnvironments.get(ENVIRONMENT)) as unknown as { data?: { status: string; statusReason: string | null } } & { status?: string; statusReason?: string | null };
      const d = env.data ?? env;
      envStatus = String(d.status); envReason = d.statusReason ?? null;
      if (envStatus !== 'pending') break;
      await sleep(10_000);
    }
    record['environment'] = { status: envStatus, reason: envReason ? clean(envReason) : null, seconds: Math.round((Date.now() - envStart) / 1000) };
    log(`[${at()}] sandbox environment ${ENVIRONMENT}: ${envStatus}${envReason ? ` (${envReason})` : ''} after ${Math.round((Date.now() - envStart) / 1000)} s`);
    if (envStatus !== 'ready') throw new Error(`sandbox environment not ready: ${envStatus}`);

    // 3. The git skill, the connector placeholder (the harness re-registers it live) and the spike agent.
    await client.settings.skills.createOrUpdate({ manifest: { type: 'git', name: SKILL, description: 'How Flask CLI commands are defined, registered, tested and documented', url: 'https://github.com/riyajenson/forgeathon', ref: SKILL_REF, path: `skills/${SKILL}` } });
    log(`[${at()}] skill ${SKILL} registered (git, ref ${SKILL_REF})`);
    await client.settings.mcpServers.createOrUpdate({ manifest: { type: 'remote', name: CONNECTOR, url: 'http://127.0.0.1:1/mcp', description: 'Forge Daytona spike', auth: { type: 'header', headers: { Authorization: 'Bearer placeholder' } } } });
    const manifest = {
      model: { name: 'spikemock/primary', params: { parallelToolCalls: false } },
      instructions: 'Daytona spike agent (scripted).',
      mcpServers: [{ name: CONNECTOR, enableTools: ['read_file', 'propose_edit'], requireApprovalForTools: ['propose_edit'] }],
      skills: [{ name: SKILL }],
      config: {
        sandbox: { enabled: true, environmentName: ENVIRONMENT }, dynamicSubAgents: { enabled: false }, generativeUi: { enabled: false }, askUserQuestions: { enabled: false },
        contextManagement: { compaction: { enabled: true, trigger: { type: 'input_tokens' as const, value: 60000 } }, largeToolResponse: { enabled: false } },
        iterationLimit: 12,
      },
    };
    const found = (await client.agents.list({ agentName: AGENT })).data.find((a) => a.name === AGENT);
    if (found) await client.agents.update(found.id, { description: 'Forge Daytona spike', manifest } as never);
    else await client.agents.create({ name: AGENT, description: 'Forge Daytona spike', manifest } as never);

    // 4. One agent turn through the harness.
    await h.start(new FakePort(root));
    const s = await h.createSession({ version: PROTOCOL_VERSION, requestId: 'spike-s', body: { workspaceRoot: root } });
    if (!s.ok) throw new Error(`session: ${JSON.stringify(s.error)}`);
    const sessionId = s.body.sessionId;
    const turnId = 'spike-turn-1';
    const sub = await h.submitTurn({ version: PROTOCOL_VERSION, requestId: 'spike-t', body: { sessionId, turnId, mode: 'agent', instruction: 'Daytona spike: run the four sandbox steps.' } });
    if (!sub.ok) throw new Error(`turn: ${JSON.stringify(sub.error)}`);
    const events: HarnessEvent[] = [];
    const results: Array<{ step: string; ok: boolean; seconds: number; output: string }> = [];
    let stepStarted = Date.now();
    let reviews = 0;
    for await (const r of h.stream({ version: PROTOCOL_VERSION, requestId: 'spike-r', body: { sessionId, turnId, afterSequence: 0 } })) {
      if (!r.ok) break;
      const e = r.body;
      events.push(e);
      if (e.t === 'tool_call') { stepStarted = Date.now(); log(`[${at()}] tool ${e.displayName}: ${e.summary.slice(0, 140)}`); }
      if (e.t === 'tool_result') {
        const name = steps('')[results.length]?.name ?? `extra-${results.length}`;
        results.push({ step: name, ok: e.ok, seconds: Math.round((Date.now() - stepStarted) / 100) / 10, output: clean(e.summary).slice(0, 1500) });
        log(`[${at()}]   ${name}: ${e.ok ? 'ok' : 'failed'} in ${results.at(-1)!.seconds} s`);
      }
      if (e.t === 'review_request') {
        // Code Mode must not reach a review: if it does, record it and reject.
        reviews++;
        const p = e.proposal;
        await h.submitReview({ version: PROTOCOL_VERSION, requestId: `spike-rev-${reviews}`, body: { sessionId: p.sessionId, turnId: p.turnId, callId: p.callId, kind: 'edit', proposalId: p.proposalId, hunks: Object.fromEntries(p.hunks.map((x) => [x.hunkId, 'reject' as const])) } });
      }
      if (e.t === 'status' && e.detail) log(`[${at()}] status: ${e.detail}`);
      if (e.t === 'error') log(`[${at()}] error: ${e.error.message}`);
    }
    const done = events.find((e) => e.t === 'done') as Extract<HarnessEvent, { t: 'done' }> | undefined;
    const fileAfter = await fs.readFile(path.join(root, FILE), 'utf8');
    // Tool results reach the harness as a 200-character summary, so the file body may be cut off: the read_file header
    // carries the file's sha256, which identifies the workspace file as well.
    const out1 = (name: string) => results.find((r) => r.step === name)?.output ?? '';
    const checks = [
      { name: 'turn done', ok: done?.status === 'done', detail: done?.status ?? 'none' },
      { name: 'sandbox exec runs (Linux, Python)', ok: /Linux/.test(out1('sandbox')) && /Python 3/.test(out1('sandbox')), detail: out1('sandbox').split('\n').slice(0, 3).join(' | ') },
      { name: 'no ~/.ssh in the sandbox', ok: /NO_SSH/.test(out1('sandbox')), detail: '' },
      { name: `git skill ${SKILL} mounted in the sandbox`, ok: new RegExp(`name: ${SKILL}`).test(out1('skill')), detail: out1('skill').split('\n')[0] ?? '' },
      { name: 'Code Mode read_file reaches the workspace through the harness', ok: /def alpha/.test(out1('codemode-read')) || out1('codemode-read').includes(sha256Hex(ORIGINAL)), detail: out1('codemode-read').slice(0, 160) },
      { name: 'Code Mode propose_edit is refused (approval-gated), no review shown', ok: reviews === 0 && !/applied|saved/i.test(out1('codemode-write')), detail: out1('codemode-write').slice(0, 200) },
      { name: 'workspace file unchanged', ok: fileAfter === ORIGINAL, detail: '' },
      { name: 'key never appears in the record', ok: true, detail: '' },
    ];
    record['steps'] = results;
    record['checks'] = checks;
    record['seconds'] = Math.round((Date.now() - t0) / 1000);
    record['turnSeconds'] = Math.round((Date.now() - stepStarted) / 1000);
    const json = clean(JSON.stringify(record, null, 2));
    checks[checks.length - 1]!.ok = !json.includes(KEY);
    await fs.writeFile(path.join(out, 'spike.json'), clean(JSON.stringify(record, null, 2)));
    console.log('\n=== Daytona spike checks');
    for (const c of checks) log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  (${c.detail.replace(/\s+/g, ' ').slice(0, 200)})` : ''}`);
    log(`\nrecord: ${path.join(out, 'spike.json')}; total ${record['seconds']} s`);
    process.exitCode = checks.every((c) => c.ok) ? 0 : 1;
  } finally {
    await h.dispose().catch(() => undefined);
    await mock.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((e: unknown) => { console.error(clean(`spike failed: ${(e as Error).stack ?? String(e)}`)); process.exit(1); });
