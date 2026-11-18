// Real-model smoke test: drives createHarness over a temporary copy of a pristine Flask checkout with a
// directory-backed editor port, auto-accepts every hunk and command, then runs the task verifications.
// Usage: node scripts/smoke-real-model.mjs [--flask ~/projects/flask-3.1.3] [--tasks A,B,C] [--keep]
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION, type ForgeHarness, type HarnessEvent, type TurnRequest } from '../contract-types';
import { createHarness } from '../harness';
import { FakePort } from '../mcp/fake-port';
import { repoRoot } from '../repo-root';
import { runSetup, type AgentTemplate, type ModelsConfig } from '../setup/setup';
import { createClient } from '../trueforge/sdk';

const run = promisify(execFile);
const TASK_A = "Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.";
const TASK_B = 'Add a new built-in CLI command flask config that prints the loaded application\'s configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

interface TurnStats {
  task: string;
  status: string;
  seconds: number;
  toolCalls: number;
  toolsByName: Record<string, number>;
  edits: string[];
  fallback?: string;
  error?: string;
  usage?: { inputTokens: number; outputTokens: number };
  contextFiles: string[];
  session?: string;
}

async function sh(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = {}): Promise<{ ok: boolean; out: string }> {
  try {
    const { stdout, stderr } = await run(cmd, args, { cwd, env: { ...process.env, ...env }, timeout: 600_000, maxBuffer: 32 * 1024 * 1024 });
    return { ok: true, out: `${stdout}${stderr}` };
  } catch (e) {
    const x = e as { stdout?: string; stderr?: string; message: string };
    return { ok: false, out: `${x.stdout ?? ''}${x.stderr ?? ''}${x.stdout || x.stderr ? '' : x.message}` };
  }
}

async function turn(h: ForgeHarness, workspace: string, task: string, body: Omit<TurnRequest, 'sessionId' | 'turnId'>): Promise<TurnStats> {
  const req = <T>(b: T) => ({ version: PROTOCOL_VERSION, requestId: randomUUID(), body: b });
  const s = await h.createSession(req({ workspaceRoot: workspace }));
  if (!s.ok) throw new Error(s.error.message);
  const sessionId = s.body.sessionId;
  const turnId = randomUUID();
  const t0 = Date.now();
  const sub = await h.submitTurn(req({ ...body, sessionId, turnId }));
  if (!sub.ok) throw new Error(sub.error.message);
  const stats: TurnStats = { task, status: 'unknown', seconds: 0, toolCalls: 0, toolsByName: {}, edits: [], contextFiles: [] };
  for await (const r of h.stream(req({ sessionId, turnId, afterSequence: 0 }))) {
    if (!r.ok) { stats.error = r.error.message; break; }
    const e: HarnessEvent = r.body;
    switch (e.t) {
      case 'session': stats.session = e.traceUrl; console.log(`  [${task}] session ${e.agentName} (${e.model}) ${e.traceUrl}`); break;
      case 'context_report': stats.contextFiles = [...new Set(e.report.selections.map((x) => x.path))]; break;
      case 'tool_call':
        stats.toolCalls++;
        stats.toolsByName[e.displayName] = (stats.toolsByName[e.displayName] ?? 0) + 1;
        console.log(`  [${task}] tool ${e.displayName} ${e.summary}`);
        break;
      case 'tool_result': if (!e.ok) console.log(`  [${task}]   failed: ${e.summary}`); break;
      case 'review_request': {
        const p = e.proposal;
        console.log(`  [${task}] review ${p.path}: ${p.hunks.length} hunk(s), accepting all`);
        const d = await h.submitReview(req({ sessionId, turnId, callId: p.callId, kind: 'edit' as const, proposalId: p.proposalId, hunks: Object.fromEntries(p.hunks.map((x) => [x.hunkId, 'accept' as const])) }));
        if (!d.ok) console.log(`  [${task}]   review refused: ${d.error.message}`);
        break;
      }
      case 'command_request': {
        console.log(`  [${task}] command ${e.command} (allowing)`);
        await h.submitReview(req({ sessionId, turnId, callId: e.callId, kind: 'command' as const, allow: true }));
        break;
      }
      case 'edit_applied': stats.edits.push(`${e.result.path}: ${e.result.status}`); break;
      case 'fallback': stats.fallback = `${e.fromModel} → ${e.toModel}: ${e.reason}`; console.log(`  [${task}] FALLBACK ${stats.fallback}`); break;
      case 'error': stats.error = e.error.message; break;
      case 'done':
        stats.status = e.status;
        if (e.usage) stats.usage = e.usage;
        break;
    }
  }
  stats.seconds = Math.round((Date.now() - t0) / 100) / 10;
  return stats;
}

async function selectionOf(root: string, rel: string, symbol: string): Promise<TurnRequest['selection']> {
  const text = await fs.readFile(path.join(root, rel), 'utf8');
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`def ${symbol}(`));
  let end = start + 1;
  while (end < lines.length && (lines[end]!.startsWith(' ') || lines[end] === '')) end++;
  while (lines[end - 1] === '') end--;
  return { path: rel, startLine: start + 1, endLine: end, text: lines.slice(start, end).join('\n') };
}

async function main(): Promise<void> {
  const repo = repoRoot();
  const flask = path.resolve(arg('--flask', path.join(os.homedir(), 'projects', 'flask-3.1.3')));
  const tasks = arg('--tasks', 'A,B').toUpperCase().split(',');
  const url = arg('--url', process.env['TRUEFORGE_URL'] ?? 'http://127.0.0.1:8790');
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-smoke-'));
  const ws = path.join(work, 'flask');
  console.log(`copying ${flask} → ${ws}`);
  await fs.cp(flask, ws, { recursive: true });
  const head = await sh('git', ['rev-parse', 'HEAD'], ws);
  console.log(`flask HEAD ${head.out.trim()}`);
  console.log('creating virtualenv (flask -e + pytest)');
  const venv = path.join(work, 'venv');
  const py = path.join(venv, 'bin', 'python');
  let r = await sh('python3', ['-m', 'venv', venv], work);
  if (r.ok) r = await sh(py, ['-m', 'pip', 'install', '-q', '-e', ws, 'pytest'], work);
  if (!r.ok) console.log(`virtualenv setup failed:\n${r.out.slice(-2000)}`);
  const env = { PATH: `${path.join(venv, 'bin')}:${process.env['PATH'] ?? ''}`, VIRTUAL_ENV: venv };
  process.env['PATH'] = env.PATH;

  const results: TurnStats[] = [];
  const verify: string[] = [];
  const h = createHarness({ trueforgeUrl: url, mcpPort: 0 });
  await h.start(new FakePort(ws));
  try {
    if (tasks.includes('A')) {
      const sel = await selectionOf(ws, 'src/flask/helpers.py', 'get_debug_flag');
      results.push(await turn(h, ws, 'A', { mode: 'inline', instruction: TASK_A, activeFile: 'src/flask/helpers.py', ...(sel ? { selection: sel } : {}) }));
      const v = await sh(py, ['-c', 'from flask.helpers import get_debug_flag; print(get_debug_flag())'], ws, { FLASK_DEBUG: 'off' });
      const v2 = await sh(py, ['-c', 'from flask.helpers import get_debug_flag; print(get_debug_flag())'], ws, { FLASK_DEBUG: 'N' });
      verify.push(`A: FLASK_DEBUG=off → ${v.out.trim()} (expected False); FLASK_DEBUG=N → ${v2.out.trim()}`);
    }
    if (tasks.includes('B')) {
      results.push(await turn(h, ws, 'B', { mode: 'agent', instruction: TASK_B }));
      const t = await sh(py, ['-m', 'pytest', 'tests/test_cli.py', '-q'], ws);
      verify.push(`B: pytest tests/test_cli.py -q → ${t.ok ? 'PASS' : 'FAIL'}: ${t.out.trim().split('\n').slice(-1)[0]}`);
      const app = path.join(work, 'smoke_app.py');
      await fs.writeFile(app, 'from flask import Flask\napp = Flask(__name__)\napp.config.update(SECRET_KEY="s3cr3t", DB_PASSWORD="pw", API_TOKEN="t", MY_KEY="k", PLAIN="visible")\n');
      const help = await sh(path.join(venv, 'bin', 'flask'), ['--app', app, '--help'], work);
      verify.push(`B: flask --help lists config → ${/\n\s+config\b/.test(help.out) ? 'yes' : 'NO'}`);
      const cfg = await sh(path.join(venv, 'bin', 'flask'), ['--app', app, 'config'], work);
      const masked = cfg.ok && !/s3cr3t|"pw"|"t"|"k"/.test(cfg.out) && cfg.out.includes('***') && cfg.out.includes('visible');
      verify.push(`B: flask config masks secrets → ${masked ? 'yes' : 'NO'}: ${cfg.out.trim().slice(0, 300)}`);
      const changed = await sh('git', ['status', '--porcelain'], ws);
      verify.push(`B: changed files → ${changed.out.trim().split('\n').join(', ')}`);
    }
    if (tasks.includes('C')) {
      const cfgPath = path.join(repo, 'config', 'models.json');
      const cfg = JSON.parse(await fs.readFile(cfgPath, 'utf8')) as ModelsConfig;
      const primaryProvider = cfg.agents.primaryModel.split('/')[0];
      const prov = cfg.providers.find((p) => (p.name ?? p.type) === primaryProvider);
      if (!prov?.apiKeyEnv) throw new Error('Task C needs the primary provider to have apiKeyEnv');
      const templates: AgentTemplate[] = [];
      for (const f of (await fs.readdir(path.join(repo, 'agent'))).filter((n) => n.endsWith('.json'))) templates.push(JSON.parse(await fs.readFile(path.join(repo, 'agent', f), 'utf8')) as AgentTemplate);
      const { client } = await createClient(url);
      const quiet = () => undefined;
      await runSetup({ client, cfg, templates, env: { ...process.env, [prov.apiKeyEnv]: 'invalid-key-for-task-c' }, log: quiet });
      try {
        await sh('git', ['checkout', '--', '.'], ws);
        const sel = await selectionOf(ws, 'src/flask/helpers.py', 'get_debug_flag');
        results.push(await turn(h, ws, 'C', { mode: 'inline', instruction: TASK_A, activeFile: 'src/flask/helpers.py', ...(sel ? { selection: sel } : {}) }));
      } finally {
        await runSetup({ client, cfg, templates, env: process.env, log: quiet });
        console.log('  [C] primary provider key restored');
      }
    }
  } finally {
    await h.dispose();
  }

  console.log('\n=== results');
  for (const s of results) {
    console.log(`${s.task}: ${s.status} in ${s.seconds}s, ${s.toolCalls} tool calls ${JSON.stringify(s.toolsByName)}, tokens ${s.usage ? `${s.usage.inputTokens} in / ${s.usage.outputTokens} out` : 'n/a'}`);
    console.log(`   context: ${s.contextFiles.join(', ')}`);
    console.log(`   edits: ${s.edits.join('; ') || 'none'}`);
    if (s.fallback) console.log(`   fallback: ${s.fallback}`);
    if (s.error) console.log(`   error: ${s.error}`);
    if (s.session) console.log(`   trace: ${s.session}`);
  }
  for (const v of verify) console.log(v);
  if (process.argv.includes('--keep')) console.log(`workspace kept at ${ws}`);
  else await fs.rm(work, { recursive: true, force: true });
}

main().catch((e) => {
  console.error(`smoke failed: ${(e as Error).message}`);
  process.exitCode = 1;
});
