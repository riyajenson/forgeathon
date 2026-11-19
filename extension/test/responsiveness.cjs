// Extension-host responsiveness during Task B on the scripted model: the harness runs in this process, so
// indexing, ranking, search, diffing and hashing share the thread with the editor. Measures event-loop delay
// for the whole turn and records a CPU profile (top functions by self time). Run with
// FORGE_E2E_TEST=responsiveness.cjs scripts/test-extension-e2e.sh.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { monitorEventLoopDelay, performance } = require('node:perf_hooks');
const inspector = require('node:inspector');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const vscode = require('vscode');
const { Workbench } = require('../out/workbench');
const { configuredHarness } = require('../out/connect');

const run = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TASK_B = 'Add a new built-in CLI command flask config that prints the loaded application\'s configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.';
/** Longest the extension host may be blocked at once during the turn. */
const MAX_BLOCK_MS = Number(process.env.FORGE_MAX_BLOCK_MS || 150);

function post(session, method, params = {}) {
  return new Promise((resolve, reject) => session.post(method, params, (e, r) => (e ? reject(e) : resolve(r))));
}

function topSelf(profile, n = 15) {
  const dt = new Map();
  const { samples, timeDeltas, nodes } = profile;
  const byId = new Map(nodes.map((x) => [x.id, x]));
  for (let i = 0; i < samples.length; i++) {
    const node = byId.get(samples[i]);
    const f = node.callFrame;
    const key = `${f.functionName || '(anonymous)'} ${(f.url || '').split('/').slice(-3).join('/')}:${f.lineNumber + 1}`;
    dt.set(key, (dt.get(key) || 0) + (timeDeltas[i] || 0) / 1000);
  }
  return [...dt.entries()].filter(([k]) => !/^\((idle|program|garbage collector)\)/.test(k)).sort((a, b) => b[1] - a[1]).slice(0, n)
    .map(([k, ms]) => `${ms.toFixed(1).padStart(8)} ms  ${k}`);
}

exports.run = async () => {
  const folder = vscode.workspace.workspaceFolders[0];
  const root = folder.uri.fsPath;
  const ui = new Workbench(folder, configuredHarness);
  const session = new inspector.Session();
  session.connect();
  await post(session, 'Profiler.enable');
  await post(session, 'Profiler.setSamplingInterval', { interval: 500 });
  const lag = monitorEventLoopDelay({ resolution: 10 });
  let last = performance.now(), maxGap = 0;
  const beat = setInterval(() => { const now = performance.now(); maxGap = Math.max(maxGap, now - last - 20); last = now; }, 20);
  try {
    // As a user would: open the panel (the harness starts while the instruction is typed), then Send.
    const warmLag = monitorEventLoopDelay({ resolution: 10 });
    warmLag.enable();
    ui.showPanel();
    const tw = performance.now();
    while (!ui.controller && performance.now() - tw < 30000) await sleep(50);
    await sleep(1000);
    warmLag.disable();
    console.log(`WARM-UP (panel opened, before Send): harness ready after ${Math.round(performance.now() - tw - 1000)} ms, longest block ${Math.round(warmLag.max / 1e6)} ms`);
    maxGap = 0;
    await post(session, 'Profiler.start');
    lag.enable();
    last = performance.now();
    const t0 = performance.now();
    let done = false;
    const answering = (async () => {
      while (!done) {
        if (ui.panel.state.reviewing) ui.decideAll('accept');
        else if (ui.panel.state.command && ui.commandAnswer) ui.commandAnswer(true);
        await sleep(80);
      }
    })();
    try { await ui.run('agent', TASK_B, {}); } finally { done = true; await answering; }
    const turnMs = performance.now() - t0;
    lag.disable();
    const { profile } = await post(session, 'Profiler.stop');
    const changed = (await run('git', ['diff', '--name-only'], { cwd: root })).stdout.trim().split('\n').filter(Boolean);
    const summary = {
      turnMs: Math.round(turnMs), maxBlockMs: Math.round(Math.max(lag.max / 1e6, maxGap)),
      p99Ms: Math.round(lag.percentile(99) / 1e6), meanMs: Number((lag.mean / 1e6).toFixed(1)), changed,
      top: topSelf(profile),
    };
    if (process.env.FORGE_PROFILE_OUT) {
      await fs.writeFile(process.env.FORGE_PROFILE_OUT, JSON.stringify(summary, null, 2));
      await fs.writeFile(process.env.FORGE_PROFILE_OUT.replace(/\.json$/, '.cpuprofile'), JSON.stringify(profile));
    }
    console.log(`RESPONSIVENESS Task B: turn ${summary.turnMs} ms, longest block ${summary.maxBlockMs} ms, p99 ${summary.p99Ms} ms, mean ${summary.meanMs} ms`);
    console.log(summary.top.join('\n'));
    assert.equal(changed.length, 3, 'Task B completed (three files changed)');
    assert.ok(summary.maxBlockMs <= MAX_BLOCK_MS, `extension host blocked for ${summary.maxBlockMs} ms (limit ${MAX_BLOCK_MS} ms)`);
    console.log(`PASS responsiveness: the extension host was never blocked longer than ${MAX_BLOCK_MS} ms during Task B`);
  } finally {
    clearInterval(beat);
    session.disconnect();
    await run('git', ['checkout', '--', '.'], { cwd: root });
    await ui.shutdown();
  }
};
