// End-to-end check of the three fixed tasks: drives createHarness over a temporary copy of a pristine Flask
// 3.1.3 checkout with a directory-backed editor port, answers every review, then runs the verifications.
// Works with the scripted demo model (scripts/e2e-mock.sh) or real models (scripts/smoke-real-model.mjs).
// Usage: node scripts/smoke-real-model.mjs [--flask DIR] [--tasks A,B,C] [--config config/models.json] [--meter-log FILE] [--json FILE] [--keep]
// --auto-approve-safe-commands: Tasks B and G with TurnRequest.autoApproveSafeCommands (pytest, python -m pytest,
// git status, git diff are not prompted).
// --deny-unrestricted: deny commands flagged unrestricted instead of allowing them (as in the demo video).
// Task G (mock model only, scripts/e2e-mock.sh): the guardrails. The scripted model sends a malformed propose_edit
// twice on one file, then five commands (git status, python -c, the unrestricted `ls src`, git status, git diff);
// the harness must flag `ls src` as unrestricted, refuse the last two by the command budget (3) without prompting,
// and spell out the propose_edit argument shape in the second refusal.
// --meter-log: the log of scripts/model-meter.mjs, to report model requests and 429s per task (TrueForge's
// internal retries included).
// --resume-after-rate-limit: when Task B stops on a rate limit (a resumable event), wait --resume-wait-sec (default:
// the harness's suggestion, 60 s) and resume it once in the same session (TurnRequest.resumeOf); the checks then
// judge the resumed turn's result. Off by default.
// Task R (mock model only, scripts/e2e-mock.sh): the resume path. The scripted model makes Task A's edit, then
// answers 429 until the turn stops with resumable; the smoke resumes it after 1 s and checks the outcome.
// --subagents: Task C's temporary re-setup keeps dynamic sub-agents on (use it when the agents were set up with it).
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
import { meterRecordsSince, requestStats, type RequestStats } from '../meter/meter';
import { editFailureKind, TASK_TERMS, testClaimMismatch, unrelatedHunk } from './edit-audit';

const run = promisify(execFile);
export const TASK_A = "Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.";
export const TASK_B = 'Add a new built-in CLI command flask config that prints the loaded application\'s configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.';
/** Mock model only: the scripted model's guardrail check (src/harness/testing/demo-script.ts). */
const GUARD_TASK = 'guardrail check: try a malformed edit twice, then run five commands.';
/** Mock model only: the scripted model's resume check. */
const RESUME_TASK = 'resume check: make get_debug_flag treat the values off and n as false (the scripted model is rate limited after its edit).';
/** Flask 3.1.3 pins pytest 9.0.2 (uv.lock); newer pytest removed an internal tests/test_cli.py imports. */
const PYTEST = 'pytest==9.0.2';

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
  reviews: number;
  reviewsByFile: Record<string, number>;
  /** Commands the user had to approve, and commands the harness auto-approved (--auto-approve-safe-commands). */
  commandPrompts: number;
  autoApproved: number;
  /** Prompts flagged unrestricted, and how many of them were denied (--deny-unrestricted). */
  unrestrictedPrompts: number;
  deniedCommands: number;
  /** run_command calls refused by the turn's command budget (command_budget_reached, other commands). */
  budgetReached: number;
  /** Test runs refused by the turn's test-command budget (command_budget_reached kind 'test'). */
  testBudgetReached: number;
  /** Sub-agents TrueForge started (dynamic sub-agents), with how each ended. */
  subagents: Array<{ name: string; task?: string; ok?: boolean; error?: string }>;
  /** Set when the turn stopped on a rate limit (resumable event). */
  resumable?: { reason: 'rate_limited' | 'stalled'; retryAfterMs: number; changedFiles: string[] };
  /** The resumed turn (--resume-after-rate-limit, Task R). */
  resumed?: TurnStats;
  sessionId?: string;
  turnId?: string;
  /** TrueForge sessions the turn ran in (more than one after a fallback). */
  runtimeSessions: string[];
  /** The model's reply text. */
  text: string;
  fallback?: string;
  /** Status lines with a detail (context compaction start and finish). */
  statusLines?: string[];
  /** Each context compaction: the model request that made the summary (from the meter log) and whether a diff had appeared. */
  compactions: { request?: number; afterToolCalls: number; beforeFirstEdit: boolean; detail: string }[];
  /** Model request that produced the first diff (from the meter log). */
  firstDiffRequest?: number;
  /** propose_edit calls that failed: malformed arguments (never reviewed) versus well-formed edits that were refused. */
  malformedEdits: number;
  refusedEdits: number;
  /** Accepted hunks whose added lines look unrelated to the task (reported only; the smoke still accepts them). */
  warnings: string[];
  /** Accepted hunks that delete a whole class or function (also listed in warnings). */
  destructiveHunks: string[];
  /** The observed outcome of the last test command (done.tests) and any contradiction in the model's reply. */
  tests?: { status: 'passed' | 'failed' | 'not_run'; command?: string; summary?: string };
  testClaimMismatch?: string;
  error?: string;
  usage?: { inputTokens: number; outputTokens: number };
  contextFiles: string[];
  contextUsed?: string;
  session?: string;
  /** Upstream model requests during the turn, from the meter log (--meter-log). */
  requests?: RequestStats;
  /** Milliseconds from sending the instruction to the first diff (review request). */
  firstDiffMs?: number;
  startedAt?: string;
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

async function turn(h: ForgeHarness, workspace: string, task: string, body: Omit<TurnRequest, 'sessionId' | 'turnId'>, decide: 'accept' | 'reject', meterLog?: string, inSession?: string): Promise<TurnStats> {
  const meterStart = (await meterRecordsSince(meterLog, 0)).lines;
  const req = <T>(b: T) => ({ version: PROTOCOL_VERSION, requestId: randomUUID(), body: b });
  let sessionId = inSession;
  if (!sessionId) {
    const s = await h.createSession(req({ workspaceRoot: workspace }));
    if (!s.ok) throw new Error(s.error.message);
    sessionId = s.body.sessionId;
  }
  const turnId = randomUUID();
  const t0 = Date.now();
  const sub = await h.submitTurn(req({ ...body, sessionId, turnId }));
  if (!sub.ok) throw new Error(sub.error.message);
  const stats: TurnStats = { task, startedAt: new Date(t0).toISOString(), status: 'unknown', seconds: 0, toolCalls: 0, toolsByName: {}, edits: [], reviews: 0, reviewsByFile: {}, commandPrompts: 0, autoApproved: 0, budgetReached: 0, testBudgetReached: 0, subagents: [], runtimeSessions: [], sessionId, turnId, unrestrictedPrompts: 0, deniedCommands: 0, text: '', contextFiles: [], compactions: [], malformedEdits: 0, refusedEdits: 0, warnings: [], destructiveHunks: [] };
  const toolNames = new Map<string, string>();
  const proposals = new Map<string, { path: string; summary: string; hunks: readonly { hunkId: string; oldText: string; newText: string; deletes?: readonly { kind: string; name: string; lines: number }[] }[] }>();
  const compactionTimes: number[] = [];
  let firstDiffAt: number | undefined;
  for await (const r of h.stream(req({ sessionId, turnId, afterSequence: 0 }))) {
    if (!r.ok) { stats.error = r.error.message; break; }
    const e: HarnessEvent = r.body;
    switch (e.t) {
      case 'session': stats.session = e.traceUrl; stats.runtimeSessions.push(e.runtimeSessionId); console.log(`  [${task}] session ${e.agentName} (${e.model}) ${e.traceUrl}`); break;
      case 'context_report':
        stats.contextFiles = [...new Set(e.report.selections.map((x) => x.path))];
        stats.contextUsed = `${e.report.estimatedTokens}/${e.report.budgetTokens} tokens, ${e.report.selections.length} items, ${e.report.skipped.length} skipped`;
        break;
      case 'tool_call':
        stats.toolCalls++;
        stats.toolsByName[e.displayName] = (stats.toolsByName[e.displayName] ?? 0) + 1;
        toolNames.set(e.callId, e.displayName);
        console.log(`  [${task}] tool ${e.displayName} ${e.summary}`);
        break;
      case 'tool_result':
        if (!e.ok) {
          console.log(`  [${task}]   failed: ${e.summary}`);
          if (toolNames.get(e.callId) === 'propose_edit') stats[editFailureKind(e.summary) === 'malformed' ? 'malformedEdits' : 'refusedEdits']++;
        }
        break;
      case 'review_request': {
        const p = e.proposal;
        stats.reviews++;
        stats.firstDiffMs ??= Date.now() - t0;
        firstDiffAt ??= Date.now();
        if (decide === 'accept') proposals.set(p.proposalId, p);
        stats.reviewsByFile[p.path] = (stats.reviewsByFile[p.path] ?? 0) + 1;
        console.log(`  [${task}] review ${p.path}: ${p.hunks.length} hunk(s) → ${decide} all`);
        const d = await h.submitReview(req({ sessionId, turnId, callId: p.callId, kind: 'edit' as const, proposalId: p.proposalId, hunks: Object.fromEntries(p.hunks.map((x) => [x.hunkId, decide])) }));
        if (!d.ok) console.log(`  [${task}]   review refused: ${d.error.message}`);
        break;
      }
      case 'command_request': {
        if (e.autoApproved) { stats.autoApproved++; console.log(`  [${task}] command ${e.command} → auto-approved`); break; }
        stats.commandPrompts++;
        const allow = !(e.unrestricted && process.argv.includes('--deny-unrestricted'));
        if (e.unrestricted) stats.unrestrictedPrompts++;
        if (!allow) stats.deniedCommands++;
        console.log(`  [${task}] command ${e.command}${e.unrestricted ? ' (UNRESTRICTED)' : ''} → ${allow ? 'allow' : 'deny'}`);
        await h.submitReview(req({ sessionId, turnId, callId: e.callId, kind: 'command' as const, allow }));
        break;
      }
      case 'command_budget_reached':
        if (e.kind === 'test') stats.testBudgetReached++; else stats.budgetReached++;
        console.log(`  [${task}] command ${e.command} → refused: ${e.kind === 'test' ? 'test-command' : 'command'} budget (${e.budget}) reached`);
        break;
      case 'subagent':
        if (e.phase === 'started') stats.subagents.push({ name: e.name, ...(e.task ? { task: e.task } : {}) });
        else {
          const sa = [...stats.subagents].reverse().find((x) => x.name === e.name && x.ok === undefined);
          if (sa) { sa.ok = e.ok === true; if (e.error) sa.error = e.error; }
        }
        break;
      case 'resumable': stats.resumable = { reason: e.reason, retryAfterMs: e.retryAfterMs, changedFiles: e.changedFiles }; console.log(`  [${task}] RESUMABLE (${e.reason === 'stalled' ? 'model stopped responding' : 'rate limited'}; ${e.changedFiles.length} file(s) changed)`); break;
      case 'text': stats.text = (stats.text + e.delta).slice(-4000); break;
      case 'edit_applied': {
        stats.edits.push(`${e.result.path}: ${e.result.status}`);
        const p = proposals.get(e.result.proposalId);
        const applied = 'appliedHunkIds' in e.result ? e.result.appliedHunkIds : [];
        for (const hunk of p?.hunks.filter((x) => applied.includes(x.hunkId)) ?? []) {
          const why = unrelatedHunk(hunk, p!.summary, TASK_TERMS[task]);
          if (why) { stats.warnings.push(`${p!.path} ("${p!.summary}"): ${why}`); console.log(`  [${task}] WARNING accepted hunk unrelated to the task: ${p!.path}: ${why}`); }
          for (const d of hunk.deletes ?? []) {
            const what = `${p!.path}: deletes ${d.kind} ${d.name} (${d.lines} lines)`;
            stats.destructiveHunks.push(what); stats.warnings.push(`destructive hunk: ${what}`);
            console.log(`  [${task}] WARNING accepted hunk deletes a whole ${d.kind}: ${what}`);
          }
        }
        break;
      }
      case 'status':
        if (e.detail) { (stats.statusLines ??= []).push(e.detail); console.log(`  [${task}] ${e.detail}`); }
        if (e.state === 'compacting') {
          compactionTimes.push(Date.now());
          stats.compactions.push({ afterToolCalls: stats.toolCalls, beforeFirstEdit: stats.reviews === 0, detail: e.detail ?? '' });
        }
        break;
      case 'fallback': stats.fallback = `${e.fromModel} → ${e.toModel}: ${e.reason}`; console.log(`  [${task}] FALLBACK ${stats.fallback}`); break;
      case 'error': stats.error = e.error.message; break;
      case 'done':
        stats.status = e.status;
        if (e.usage) stats.usage = e.usage;
        if (e.tests) {
          stats.tests = { status: e.tests.status, ...(e.tests.command ? { command: e.tests.command } : {}), ...(e.tests.summary ? { summary: e.tests.summary } : {}) };
          const mismatch = testClaimMismatch(stats.text, e.tests);
          if (mismatch) { stats.testClaimMismatch = mismatch; console.log(`  [${task}] WARNING test claim mismatch: ${mismatch}`); }
        }
        break;
    }
  }
  stats.seconds = Math.round((Date.now() - t0) / 100) / 10;
  if (meterLog) {
    await new Promise((r) => setTimeout(r, 200)); // the meter writes its record when the upstream response ends
    const { records } = await meterRecordsSince(meterLog, meterStart);
    stats.requests = requestStats(records);
    // The meter stamps a request when it starts: the summary request is the first one at or after the compaction event.
    const requestAt = (ms: number) => { const i = records.findIndex((r) => Date.parse(r.ts) >= ms - 1000); return i < 0 ? undefined : i + 1; };
    stats.compactions.forEach((c, i) => { const n = requestAt(compactionTimes[i]!); if (n !== undefined) c.request = n; });
    // The diff appears after the request that proposed it, so that request started before the diff.
    if (firstDiffAt !== undefined) { const n = records.filter((r) => Date.parse(r.ts) <= firstDiffAt!).length; if (n > 0) stats.firstDiffRequest = n; }
  }
  return stats;
}

async function selectionOf(root: string, rel: string, symbol: string): Promise<NonNullable<TurnRequest['selection']>> {
  const text = await fs.readFile(path.join(root, rel), 'utf8');
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`def ${symbol}(`));
  if (start < 0) throw new Error(`${symbol} not found in ${rel}`);
  let end = start + 1;
  while (end < lines.length && (lines[end]!.startsWith(' ') || lines[end] === '')) end++;
  while (lines[end - 1] === '') end--;
  return { path: rel, startLine: start + 1, endLine: end, text: lines.slice(start, end).join('\n') };
}

async function loadTemplates(repo: string): Promise<AgentTemplate[]> {
  const out: AgentTemplate[] = [];
  for (const f of (await fs.readdir(path.join(repo, 'agent'))).filter((n) => n.endsWith('.json')).sort()) out.push(JSON.parse(await fs.readFile(path.join(repo, 'agent', f), 'utf8')) as AgentTemplate);
  return out;
}

async function main(): Promise<void> {
  const repo = repoRoot();
  // Default: the checkout the README prepares (~/flask-demo), else ~/projects/flask-3.1.3.
  const defaults = [path.join(os.homedir(), 'flask-demo'), path.join(os.homedir(), 'projects', 'flask-3.1.3')];
  let defaultFlask = defaults[0]!;
  for (const d of defaults) if (await fs.access(path.join(d, '.git')).then(() => true, () => false)) { defaultFlask = d; break; }
  const flask = path.resolve(arg('--flask', defaultFlask));
  const tasks = arg('--tasks', 'A,B').toUpperCase().split(',');
  const url = arg('--url', process.env['TRUEFORGE_URL'] ?? 'http://127.0.0.1:8790');
  const configPath = path.resolve(arg('--config', path.join(repo, 'config', 'models.json')));
  const meterLog = process.argv.includes('--meter-log') ? path.resolve(arg('--meter-log', '')) : undefined;
  // Tasks B and G, like the editor setting forge.autoApproveSafeCommands (default off).
  const autoApprove = process.argv.includes('--auto-approve-safe-commands');
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-smoke-'));
  const ws = path.join(work, 'flask');
  console.log(`copying ${flask} → ${ws}`);
  // Without the source's virtualenv (its scripts point back at the source), then reset to the committed state.
  await fs.cp(flask, ws, { recursive: true, filter: (src) => !/[\\/](\.venv|venv)$/.test(src) });
  await sh('git', ['checkout', '-q', '--', '.'], ws);
  await sh('git', ['clean', '-qfdx'], ws);
  const head = (await sh('git', ['rev-parse', 'HEAD'], ws)).out.trim();
  console.log(`flask HEAD ${head}`);
  console.log(`creating virtualenv (flask -e, ${PYTEST})`);
  const venv = path.join(work, 'venv');
  const py = path.join(venv, 'bin', 'python');
  let r = await sh('python3', ['-m', 'venv', venv], work);
  if (r.ok) r = await sh(py, ['-m', 'pip', 'install', '-q', '-e', ws, PYTEST], work);
  if (!r.ok) throw new Error(`virtualenv setup failed:\n${r.out.slice(-2000)}`);
  process.env['PATH'] = `${path.join(venv, 'bin')}:${process.env['PATH'] ?? ''}`;
  process.env['VIRTUAL_ENV'] = venv;

  const results: TurnStats[] = [];
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
  const check = (name: string, ok: boolean, detail = '') => checks.push({ name, ok, detail });
  const debugFlag = async (value: string) => (await sh(py, ['-c', 'from flask.helpers import get_debug_flag; print(get_debug_flag())'], ws, { FLASK_DEBUG: value })).out.trim().split('\n').pop() ?? '';
  const status = async () => (await sh('git', ['status', '--porcelain'], ws)).out.trim();

  const h = createHarness({ trueforgeUrl: url, mcpPort: 0 });
  await h.start(new FakePort(ws));
  try {
    if (tasks.includes('A')) {
      const selection = await selectionOf(ws, 'src/flask/helpers.py', 'get_debug_flag');
      const a = await turn(h, ws, 'A', { mode: 'inline', instruction: TASK_A, activeFile: 'src/flask/helpers.py', selection }, 'accept', meterLog);
      results.push(a);
      check('A: turn done', a.status === 'done', a.error ?? '');
      const savedHelpers = a.edits.filter((x) => x.startsWith('src/flask/helpers.py: saved'));
      check('A: exactly one applied edit, saved to helpers.py', savedHelpers.length === 1 && a.edits.length === 1, `${a.reviews} review(s); ${a.edits.join('; ')}`);
      const off = await debugFlag('off');
      check('A: FLASK_DEBUG=off → False', off === 'False', off);
      const n = await debugFlag('N');
      check('A: FLASK_DEBUG=N → False (case-insensitive)', n === 'False', n);
      const one = await debugFlag('1');
      check('A: FLASK_DEBUG=1 → True (unchanged)', one === 'True', one);
      const doc = await fs.readFile(path.join(ws, 'src/flask/helpers.py'), 'utf8');
      const fn = doc.slice(doc.indexOf('def get_debug_flag'), doc.indexOf('def get_load_dotenv'));
      const docstring = /"""([\s\S]*?)"""/.exec(fn)?.[1] ?? '';
      const missing = ['0', 'false', 'no', 'off', 'n'].filter((v) => !new RegExp(`["'\`]${v}["'\`]`, 'i').test(docstring));
      check('A: docstring lists every false value (0, false, no, off, n)', docstring !== '' && missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : '');
    }
    if (tasks.includes('B')) {
      const bBody = { mode: 'agent' as const, instruction: TASK_B, ...(autoApprove ? { autoApproveSafeCommands: true } : {}) };
      const b = await turn(h, ws, 'B', bBody, 'accept', meterLog);
      results.push(b);
      if (b.resumable && process.argv.includes('--resume-after-rate-limit')) {
        const waitMs = process.argv.includes('--resume-wait-sec') ? Number(arg('--resume-wait-sec', '60')) * 1000 : b.resumable.retryAfterMs;
        console.log(`  [B] waiting ${Math.round(waitMs / 1000)} s, then resuming the turn once`);
        await new Promise((r) => setTimeout(r, waitMs));
        b.resumed = await turn(h, ws, 'B+resume', { ...bBody, resumeOf: b.turnId! }, 'accept', meterLog, b.sessionId);
      }
      const bFinal = b.resumed ?? b;
      check(b.resumed ? 'B: turn done (after one Resume)' : 'B: turn done', bFinal.status === 'done', bFinal.error ?? '');
      const changed = (await sh('git', ['diff', '--name-only'], ws)).out.trim().split('\n').filter(Boolean);
      const needed = ['src/flask/cli.py', 'tests/test_cli.py', 'docs/cli.rst'];
      check('B: ≥3 files changed incl. cli.py, test_cli.py, cli.rst', needed.every((f) => changed.includes(f)), changed.join(', '));
      check('B: context report includes src/flask/cli.py', b.contextFiles.includes('src/flask/cli.py'), b.contextUsed ?? '');
      const t = await sh(py, ['-m', 'pytest', 'tests/test_cli.py', '-q'], ws);
      check('B: pytest tests/test_cli.py -q passes', t.ok, t.out.trim().split('\n').pop() ?? '');
      const app = path.join(work, 'smoke_app.py');
      await fs.writeFile(app, 'from flask import Flask\napp = Flask(__name__)\napp.config.update(SECRET_KEY="s3cr3t", DB_PASSWORD="pw", API_TOKEN="tok", MY_KEY="k1", PLAIN="visible")\n');
      const help = await sh(path.join(venv, 'bin', 'flask'), ['--app', app, '--help'], work);
      check('B: flask --help lists config', /\n\s+config\s/.test(help.out), '');
      const cfg = await sh(path.join(venv, 'bin', 'flask'), ['--app', app, 'config'], work);
      let masked = false;
      try {
        const data = JSON.parse(cfg.out) as Record<string, unknown>;
        masked = ['SECRET_KEY', 'DB_PASSWORD', 'API_TOKEN', 'MY_KEY'].every((k) => data[k] === '***') && data['PLAIN'] === 'visible';
      } catch { /* not JSON */ }
      check('B: flask config prints JSON with secrets masked', masked, cfg.out.trim().slice(0, 200));
    }
    if (tasks.includes('G')) {
      await sh('git', ['checkout', '--', '.'], ws);
      const g = await turn(h, ws, 'G', { mode: 'agent', instruction: GUARD_TASK, ...(autoApprove ? { autoApproveSafeCommands: true } : {}) }, 'accept', meterLog);
      results.push(g);
      check('G: turn done', g.status === 'done', g.error ?? '');
      const shown = g.commandPrompts + g.autoApproved;
      check('G: 3 commands shown (budget 3), the other 2 refused without a prompt', shown === 3 && g.budgetReached === 2,
        `${g.commandPrompts} asked, ${g.autoApproved} auto-approved, ${g.budgetReached} refused`);
      check(`G: auto-approval ${autoApprove ? 'on: git status not asked; python -c and ls asked' : 'off: every shown command asked'}`,
        autoApprove ? g.autoApproved === 1 && g.commandPrompts === 2 : g.autoApproved === 0 && g.commandPrompts === 3, '');
      const denyUnrestricted = process.argv.includes('--deny-unrestricted');
      check(`G: ⚠ Unrestricted prompt for ls src, ${denyUnrestricted ? 'denied' : 'allowed'}`,
        g.unrestrictedPrompts === 1 && g.deniedCommands === (denyUnrestricted ? 1 : 0), `${g.unrestrictedPrompts} unrestricted, ${g.deniedCommands} denied`);
      check('G: the model received both budget refusals, one shape hint and the denial (if any)',
        new RegExp(`2 command\\(s\\) refused by the budget; shape hint in 1 refusal\\(s\\); ${denyUnrestricted ? 1 : 0} command\\(s\\) denied`).test(g.text), g.text.trim().slice(-200));
      check('G: no file changed', (await status()) === '', '');
    }
    if (tasks.includes('R')) {
      await sh('git', ['checkout', '--', '.'], ws);
      const rBody = { mode: 'agent' as const, instruction: RESUME_TASK };
      const r1 = await turn(h, ws, 'R', rBody, 'accept', meterLog);
      results.push(r1);
      check('R: the turn stopped on the rate limit with resumable, after saving helpers.py',
        r1.status === 'error' && JSON.stringify(r1.resumable?.changedFiles) === '["src/flask/helpers.py"]' && r1.edits.join() === 'src/flask/helpers.py: saved', `${r1.status}; ${JSON.stringify(r1.resumable)}; ${r1.edits.join('; ')}`);
      if (r1.resumable) {
        await new Promise((r) => setTimeout(r, 1000));
        r1.resumed = await turn(h, ws, 'R+resume', { ...rBody, resumeOf: r1.turnId! }, 'accept', meterLog, r1.sessionId);
        const r2 = r1.resumed;
        check('R: Resume finished in the same TrueForge session, with the earlier tool results in view',
          r2.status === 'done' && r2.runtimeSessions[0] === r1.runtimeSessions[0] && /Resume check finished: [1-9]\d* earlier tool result\(s\) in view; src\/flask\/helpers\.py already changed\./.test(r2.text),
          `${r2.status}; ${r2.text.trim().slice(-160)}`);
      }
      const off = await debugFlag('off');
      check('R: the edit from before the rate limit is in place (FLASK_DEBUG=off → False)', off === 'False', off);
    }
    if (tasks.includes('C')) {
      await sh('git', ['checkout', '--', '.'], ws);
      const cfg = JSON.parse(await fs.readFile(configPath, 'utf8')) as ModelsConfig;
      const primaryProvider = cfg.agents.primaryModel.split('/')[0];
      const prov = cfg.providers.find((p) => (p.name ?? p.type) === primaryProvider);
      if (!prov?.apiKeyEnv) throw new Error('Task C needs the primary provider to have apiKeyEnv');
      const templates = await loadTemplates(repo);
      const { client } = await createClient(url);
      const quiet = () => undefined;
      const subAgents = process.argv.includes('--subagents');
      await runSetup({ client, cfg, templates, env: { ...process.env, [prov.apiKeyEnv]: 'invalid-key-for-task-c' }, log: quiet, subAgents });
      try {
        const selection = await selectionOf(ws, 'src/flask/helpers.py', 'get_debug_flag');
        // Reject the fallback's proposal so the workspace check shows no change.
        const c = await turn(h, ws, 'C', { mode: 'inline', instruction: TASK_A, activeFile: 'src/flask/helpers.py', selection }, 'reject', meterLog);
        results.push(c);
        check('C: primary failed and the fallback model took over', Boolean(c.fallback), c.fallback ?? c.error ?? '');
        check('C: turn finished without an error', c.status === 'done', c.error ?? '');
        const st = await status();
        check('C: git status clean (no changed files)', st === '', st);
      } finally {
        await runSetup({ client, cfg, templates, env: process.env, log: quiet, subAgents });
        console.log('  [C] primary provider key restored');
      }
    }
  } finally {
    await h.dispose();
  }

  console.log('\n=== turns');
  for (const s of results.flatMap((x) => (x.resumed ? [x, x.resumed] : [x]))) {
    console.log(`${s.task}: ${s.status} in ${s.seconds}s, ${s.toolCalls} tool calls ${JSON.stringify(s.toolsByName)}, ${s.reviews} review(s) ${JSON.stringify(s.reviewsByFile)}, ${s.commandPrompts} command approval(s), ${s.autoApproved} auto-approved, ${s.budgetReached} refused by the budget, ${s.unrestrictedPrompts} unrestricted (${s.deniedCommands} denied), tokens ${s.usage ? `${s.usage.inputTokens} in / ${s.usage.outputTokens} out` : 'n/a'}`);
    if (s.firstDiffMs !== undefined) console.log(`   first diff after ${(s.firstDiffMs / 1000).toFixed(1)} s`);
    if (s.requests) console.log(`   model requests: ${s.requests.total} (${s.requests.status429} × 429, ${s.requests.otherErrors} other errors) ${JSON.stringify(s.requests.byModel)}`);
    if (s.contextUsed) console.log(`   context: ${s.contextUsed}: ${s.contextFiles.join(', ')}`);
    console.log(`   edits: ${s.edits.join('; ') || 'none'}`);
    if (s.text.trim()) console.log(`   reply: ${s.text.trim().replace(/\s+/g, ' ').slice(-300)}`);
    if (s.fallback) console.log(`   fallback: ${s.fallback}`);
    for (const line of s.statusLines ?? []) console.log(`   status: ${line}`);
    for (const c of s.compactions) console.log(`   compaction at request ${c.request ?? '?'} after ${c.afterToolCalls} tool calls, ${c.beforeFirstEdit ? 'BEFORE' : 'after'} the first edit`);
    if (s.firstDiffRequest !== undefined) console.log(`   first diff from request ${s.firstDiffRequest}`);
    console.log(`   propose_edit failures: ${s.malformedEdits} malformed, ${s.refusedEdits} refused; warnings: ${s.warnings.length}`);
    console.log(`   test runs refused by the test-command budget: ${s.testBudgetReached}; sub-agent delegations: ${s.subagents.length}${s.subagents.length ? ` ${JSON.stringify(s.subagents.map((x) => ({ name: x.name, ok: x.ok, task: x.task?.slice(0, 120) })))}` : ''}`);
    if (s.resumable) console.log(`   stopped (${s.resumable.reason === 'stalled' ? 'model stopped responding' : 'rate limit'}): resumable (${s.resumable.changedFiles.join(', ') || 'no files changed'})`);
    if (s.tests) console.log(`   last test command: ${s.tests.status}${s.tests.summary ? ` (${s.tests.summary})` : ''}${s.testClaimMismatch ? `; MISMATCH: ${s.testClaimMismatch}` : '; matches the reply'}`);
    for (const w of s.warnings) console.log(`   WARNING ${w}`);
    if (s.error) console.log(`   error: ${s.error}`);
    if (s.session) console.log(`   trace: ${s.session}`);
  }
  console.log('\n=== checks');
  for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed ? `\n${failed} check(s) FAILED` : `\nall ${checks.length} checks passed`);
  if (failed) process.exitCode = 1;
  const jsonOut = arg('--json', '');
  if (jsonOut) await fs.writeFile(jsonOut, JSON.stringify({ url, config: configPath, results, checks }, null, 2));
  if (process.argv.includes('--keep')) console.log(`workspace kept at ${ws}`);
  else await fs.rm(work, { recursive: true, force: true });
}

main().catch((e) => {
  console.error(`smoke failed: ${(e as Error).message}`);
  process.exitCode = 1;
});
