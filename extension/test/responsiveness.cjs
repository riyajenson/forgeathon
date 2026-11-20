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
const path = require('node:path');

const run = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TASK_B = 'Add a new built-in CLI command flask config that prints the loaded application\'s configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.';
/** Longest the extension host may be blocked at once during the turn. */
const MAX_BLOCK_MS = Number(process.env.FORGE_MAX_BLOCK_MS || 150);
// End-to-frame includes extension-host IPC and the webview's next paint opportunity.
// At 60 Hz, allow three frames for control state and two for streamed text.
const MAX_CONTROL_FRAME_MS = Number(process.env.FORGE_MAX_CONTROL_FRAME_MS || 50);
const MAX_TEXT_FRAME_MS = Number(process.env.FORGE_MAX_TEXT_FRAME_MS || 100);

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

async function runSemanticWorkerSmoke() {
  let api;
  try { api = require('../../src/harness/dist/src/harness/context/semantic'); } catch { api = undefined; }
  assert.equal(typeof api?.ThreadEmbeddingClient, 'function', 'semantic worker client is exported');
  const client = new api.ThreadEmbeddingClient({ workerPath: path.join(__dirname, 'semantic-worker-fixture.cjs') });
  let beats = 0;
  const progress = [];
  const beat = setInterval(() => { beats++; }, 5);
  try {
    const vectors = await client.embed(['fixture'], new AbortController().signal, (event) => progress.push(event));
    assert.deepEqual(vectors, [[1, 0]]);
    assert.ok(beats >= 2, `extension event loop kept running while worker computed (${beats} ticks)`);
    assert.deepEqual(progress, [{ status: 'progress_total', progress: 100 }]);
  } finally {
    clearInterval(beat);
    await client.dispose();
  }
}

exports.run = async () => {
  const vscode = require('vscode');
  const { Workbench } = require('../out/workbench');
  const { configuredHarness } = require('../out/connect');
  await runSemanticWorkerSmoke();
  const folder = vscode.workspace.workspaceFolders[0];
  const root = folder.uri.fsPath;
  const ui = new Workbench(folder, configuredHarness);
  // Test-only attribution for outliers: event type plus extension dispatch time
  // and postMessage-to-rAF acknowledgement time. Store numbers only.
  const renderOrigins = new Map();
  const renderTiming = new Map();
  const renderVisibility = { control: { visible: 0, hidden: 0 }, text: { visible: 0, hidden: 0 } };
  let currentRenderOrigin = 'internal';
  const originalEvent = ui.panel.event.bind(ui.panel);
  ui.panel.event = (event) => {
    const previous = currentRenderOrigin;
    currentRenderOrigin = event.t;
    try { originalEvent(event); } finally { currentRenderOrigin = previous; }
  };
  const originalPostRender = ui.panel.postRender.bind(ui.panel);
  ui.panel.postRender = (kind, eventAt, eventWallAt) => {
    const sequence = ui.panel.renderSequence + 1;
    const now = performance.now();
    renderOrigins.set(sequence, currentRenderOrigin);
    renderTiming.set(sequence, { eventAt: kind === 'control' ? eventAt : now, postedAt: now, kind });
    return originalPostRender(kind, eventAt, eventWallAt);
  };
  const originalAcknowledgeRender = ui.panel.acknowledgeRender.bind(ui.panel);
  ui.panel.acknowledgeRender = (sequence, frameMs, domMs, visibility, eventToFrameMs, textEventToFrameMs) => {
    const timing = renderTiming.get(sequence);
    if (timing?.kind && (timing.kind === 'control' || timing.kind === 'text'))
      renderVisibility[timing.kind][visibility === 1 ? 'visible' : 'hidden']++;
    if (timing?.kind === 'control' && timing.eventAt !== undefined) {
      const samples = ui.controlRenderTimings ??= new Map();
      const name = renderOrigins.get(sequence) || 'internal';
      const bucket = samples.get(name) ?? [];
      const acknowledgedAt = performance.now();
      bucket.push({
        eventToPostMs: Math.max(0, timing.postedAt - timing.eventAt),
        postToHostAckMs: Math.max(0, acknowledgedAt - timing.postedAt),
        webviewFrameMs: typeof frameMs === 'number' ? frameMs : 0,
        webviewDomMs: typeof domMs === 'number' ? domMs : 0,
        visibility: visibility === 1 ? 1 : 0,
        eventToFrameMs: typeof eventToFrameMs === 'number' ? eventToFrameMs : 0,
        textEventToFrameMs: typeof textEventToFrameMs === 'number' ? textEventToFrameMs : 0
      });
      samples.set(name, bucket);
    }
    renderTiming.delete(sequence);
    renderOrigins.delete(sequence);
    return originalAcknowledgeRender(sequence, frameMs, domMs, visibility, eventToFrameMs, textEventToFrameMs);
  };
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
    await sleep(30); // allow the webview's next animation-frame acknowledgements to arrive
    const render = ui.panel.getRenderMetrics();
    lag.disable();
    const { profile } = await post(session, 'Profiler.stop');
    const changed = (await run('git', ['diff', '--name-only'], { cwd: root })).stdout.trim().split('\n').filter(Boolean);
    const summary = {
      turnMs: Math.round(turnMs), maxBlockMs: Math.round(Math.max(lag.max / 1e6, maxGap)),
      p99Ms: Math.round(lag.percentile(99) / 1e6), meanMs: Number((lag.mean / 1e6).toFixed(1)), changed, render,
      top: topSelf(profile),
    };
    if (process.env.FORGE_PROFILE_OUT) {
      await fs.writeFile(process.env.FORGE_PROFILE_OUT, JSON.stringify(summary, null, 2));
      await fs.writeFile(process.env.FORGE_PROFILE_OUT.replace(/\.json$/, '.cpuprofile'), JSON.stringify(profile));
    }
    console.log(`RESPONSIVENESS Task B: turn ${summary.turnMs} ms, longest block ${summary.maxBlockMs} ms, p99 ${summary.p99Ms} ms, mean ${summary.meanMs} ms`);
    console.log(`WEBVIEW event-to-rAF: control n=${render.control.count} p50=${render.control.p50Ms} ms p95=${render.control.p95Ms} ms; text n=${render.text.count} p50=${render.text.p50Ms} ms p95=${render.text.p95Ms} ms`);
    console.log(`WEBVIEW receive-to-rAF: control n=${render.control.webviewFrame.count} p50=${render.control.webviewFrame.p50Ms} ms p95=${render.control.webviewFrame.p95Ms} ms; text n=${render.text.webviewFrame.count} p50=${render.text.webviewFrame.p50Ms} ms p95=${render.text.webviewFrame.p95Ms} ms`);
    console.log(`WEBVIEW DOM update: control p95=${render.control.webviewDom.p95Ms} ms; text p95=${render.text.webviewDom.p95Ms} ms`);
    console.log(`WEBVIEW visibility: control visible=${renderVisibility.control.visible} hidden=${renderVisibility.control.hidden}; text visible=${renderVisibility.text.visible} hidden=${renderVisibility.text.hidden}`);
    const byType = [...ui.controlRenderTimings.entries()].map(([name, samples]) => {
      const percentile = (key, p) => {
        const sorted = samples.map(sample => sample[key]).sort((a, b) => a - b);
        return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] || 0);
      };
      return `${name} n=${samples.length} visible=${samples.filter(sample => sample.visibility === 1).length} event→post p95=${percentile('eventToPostMs', 0.95)} ms post→host ack p95=${percentile('postToHostAckMs', 0.95)} ms DOM p95=${percentile('webviewDomMs', 0.95)} ms webview receive→rAF p95=${percentile('webviewFrameMs', 0.95)} ms event→rAF p95=${percentile('eventToFrameMs', 0.95)} ms`;
    });
    console.log(`CONTROL FRAME BREAKDOWN (numeric only):\n${byType.join('\n')}`);
    console.log(summary.top.join('\n'));
    assert.ok(render.control.count > 0, 'the real webview acknowledged control renders');
    assert.ok(render.text.count > 0, 'the real webview acknowledged text renders');
    assert.ok(render.control.webviewDom.p95Ms <= 10, `control DOM update p95 was ${render.control.webviewDom.p95Ms} ms (limit 10 ms)`);
    assert.ok(render.text.webviewDom.p95Ms <= 10, `text DOM update p95 was ${render.text.webviewDom.p95Ms} ms (limit 10 ms)`);
    if (render.control.webviewFrame.p95Ms > 100 || render.text.webviewFrame.p95Ms > 100) {
      console.log('FRAME TIMING NOT GATED: requestAnimationFrame cadence exceeded 100 ms; retaining the measurements as diagnostics.');
    } else {
      assert.ok(render.control.p95Ms <= MAX_CONTROL_FRAME_MS, `control event-to-rAF p95 was ${render.control.p95Ms} ms (limit ${MAX_CONTROL_FRAME_MS} ms)`);
      assert.ok(render.text.p95Ms <= MAX_TEXT_FRAME_MS, `text event-to-rAF p95 was ${render.text.p95Ms} ms (limit ${MAX_TEXT_FRAME_MS} ms)`);
    }
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


if (require.main === module && process.argv.includes('--semantic-worker-smoke')) {
  runSemanticWorkerSmoke().then(() => {
    console.log('PASS semantic worker: embedding ran off the extension event loop');
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
