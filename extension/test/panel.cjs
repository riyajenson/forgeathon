const assert = require('node:assert/strict');
const vscode = require('vscode');
const { AgentPanel, AgentViewState } = require('../out/agentPanel');
const { Workbench } = require('../out/workbench');
const { TurnController } = require('../out/turn');
const { EditReview } = require('../out/review');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async condition => {
  for (let i = 0; i < 150; i++) { if (await condition()) return; await delay(40); }
  throw Error('Timed out waiting for UI');
};
async function panelRefreshChecks() {
  const originalCreateWebviewPanel = vscode.window.createWebviewPanel;
  const messages = [];
  let receive, disposed;
  const webview = {
    asWebviewUri: uri => uri,
    onDidReceiveMessage: fn => { receive = fn; return { dispose() {} }; },
    postMessage: async state => {
      messages.push(state);
      // Acknowledge inline to keep these host-side timing assertions deterministic.
      // agent-media.cjs verifies the actual webview script waits for requestAnimationFrame.
      receive?.({ action: 'rendered', sequence: state.renderSequence, frameMs: 0, domMs: 0, visibility: 1, eventToFrameMs: 0, textEventToFrameMs: 0 });
      return true;
    }
  };
  const panel = {
    webview, reveal() {}, onDidDispose: fn => { disposed = fn; return { dispose() {} }; },
    dispose() { disposed?.(); }
  };
  vscode.window.createWebviewPanel = () => panel;
  const closedPanelAgent = new AgentPanel({ send: async () => {}, stop: async () => {}, review() {}, command() {} });
  closedPanelAgent.event({ t: 'text', messageId: 'before-open', delta: 'history before opening' });
  closedPanelAgent.open();
  receive({ action: 'ready' });
  await delay(25);
  assert.equal(messages.at(-1).text, 'history before opening', 'the first panel snapshot includes text received before it opened');
  assert.equal(closedPanelAgent.getRenderMetrics().text.count, 0, 'text received with no panel is not retained as pending render work');
  closedPanelAgent.dispose();
  messages.length = 0;

  const agent = new AgentPanel({ send: async () => {}, stop: async () => {}, review() {}, command() {} });
  try {
    agent.open();
    receive({ action: 'ready' });
    await delay(25);
    messages.length = 0;

    agent.event({ t: 'text', messageId: 'm', delta: 'first ' });
    agent.event({ t: 'text', messageId: 'm', delta: 'second' });
    await delay(25);
    assert.equal(messages.length, 1, 'text fragments share one 16 ms refresh');
    assert.equal(messages[0].text, 'first second', 'coalescing preserves text order');
    assert.ok(Number.isInteger(messages[0].renderSequence), 'each posted state has a render sequence');
    await delay(20);

    const beforeControl = messages.length;
    agent.event({ t: 'text', messageId: 'm', delta: ' third' });
    agent.event({ t: 'command_request', callId: 'command', command: 'sleep 1', cwd: '.' });
    assert.equal(messages.length, beforeControl + 1, 'control state posts immediately while text refresh is pending');
    assert.equal(messages.at(-1).text, 'first second third', 'the immediate control snapshot includes queued text');
    assert.equal(messages.at(-1).command.command, 'sleep 1');
    assert.equal(messages.at(-1).command.cwd, '.');
    await delay(20);
    assert.equal(messages.length, beforeControl + 1, 'the flushed text does not cause a duplicate refresh');

    const metrics = agent.getRenderMetrics();
    assert.ok(metrics.control.count > 0, 'control frame acknowledgements contribute measurements');
    assert.ok(metrics.text.count > 0, 'text frame acknowledgements contribute measurements');
    assert.ok(metrics.control.webviewFrame.count > 0 && metrics.text.webviewFrame.count > 0, 'webview frame timing is recorded');
    assert.ok(Number.isFinite(metrics.control.p95Ms) && Number.isFinite(metrics.text.p95Ms), 'latency summaries contain numeric p95 values');

    const beforeClose = messages.length;
    agent.event({ t: 'text', messageId: 'm', delta: ' never posted' });
    disposed();
    await delay(25);
    assert.equal(messages.length, beforeClose, 'a queued refresh is discarded when its webview closes');
  } finally {
    agent.dispose();
    vscode.window.createWebviewPanel = originalCreateWebviewPanel;
  }
}
exports.run = async () => {
  await require('./agent-media.cjs').run();
  await panelRefreshChecks();
  await require('./review.cjs').run();
  const flagged = new AgentViewState();
  flagged.update({t:'command_request',callId:'x',command:'rm -rf build',cwd:'.',unrestricted:true,warning:'Unrestricted command: it can change any file without hunk review and is not sandboxed.'});
  assert.match(flagged.command.warning, /without hunk review/, 'the panel carries the unrestricted warning');
  flagged.update({t:'command_request',callId:'y',command:'pytest -q',cwd:'.'});
  assert.equal(flagged.command.warning, undefined, 'listed commands carry no warning');
  assert.equal(flagged.command.facts, '\u2713 On the verification allowlist \u00b7 Sandbox: active (bubblewrap: read-only workspace, no network, no home directory, no API keys; refused if unavailable)');
  flagged.update({t:'command_request',callId:'z',command:'ls src',cwd:'.',unrestricted:true,warning:'Unrestricted command'});
  assert.match(flagged.command.facts, /^\u26a0 Outside the verification allowlist .* \u00b7 Sandbox: active/, 'the two facts are stated separately');
  const auto = new AgentViewState();
  auto.update({t:'command_request',callId:'z',command:'python -m pytest tests/test_x.py -q',cwd:'.',autoApproved:true});
  assert.equal(auto.command, undefined, 'no Allow/Deny prompt for an auto-approved command');
  assert.deepEqual(auto.tools, [{id:'auto:z',label:'auto-approved: python -m pytest tests/test_x.py -q',detail:'cwd: .'}], 'shown in the activity list');
  assert.equal(auto.status, 'auto-approved: python -m pytest tests/test_x.py -q');
  const budget = new AgentViewState();
  budget.update({t:'command_budget_reached',callId:'b',command:'python -m pytest',budget:3});
  assert.equal(budget.command, undefined, 'a command refused by the budget opens no prompt');
  assert.equal(budget.status, 'command budget reached');
  assert.deepEqual(budget.tools, [{id:'budget:b',label:'command budget reached (3 per turn): python -m pytest',detail:'not run'}]);
  budget.update({t:'command_budget_reached',callId:'t',command:'pytest -q',budget:3,kind:'test'});
  assert.equal(budget.status, 'test-command budget reached');
  assert.deepEqual(budget.tools[1], {id:'budget:t',label:'test-command budget reached (3 per turn): pytest -q',detail:'not run'}, 'the test budget is named');
  const subs = new AgentViewState();
  subs.update({t:'subagent',phase:'started',threadId:'th2',name:'explorer',task:'Find where commands are registered'});
  assert.deepEqual(subs.tools, [{id:'subagent:th2',label:'Sub-agent: explorer',detail:'Find where commands are registered'}]);
  subs.update({t:'subagent',phase:'finished',threadId:'th2',name:'explorer',ok:true});
  assert.deepEqual(subs.tools, [{id:'subagent:th2',label:'Sub-agent: explorer',detail:'Done'}], 'one row per sub-agent, updated when it ends');
  subs.update({t:'subagent',phase:'finished',threadId:'th3',name:'scout',ok:false,error:'Model unavailable'});
  assert.deepEqual(subs.tools[1], {id:'subagent:th3',label:'Sub-agent: scout',detail:'Failed: Model unavailable'});
  const limited = new AgentViewState();
  const t0 = Date.now();
  limited.update({t:'resumable',reason:'rate_limited',retryAfterMs:60000,changedFiles:['src/flask/cli.py']});
  assert.deepEqual(limited.resume.files, ['src/flask/cli.py']);
  assert.ok(limited.resume.at >= t0 + 60000 && limited.resume.at <= Date.now() + 60000, 'Resume is offered after the suggested wait');
  assert.equal(limited.resume.reason, 'rate_limited');
  const stalled = new AgentViewState();
  stalled.update({t:'resumable',reason:'stalled',retryAfterMs:5000,changedFiles:['tests/test_cli.py']});
  assert.equal(stalled.resume.reason, 'stalled', 'a stall after writes offers Resume too');
  assert.ok(stalled.resume.at <= Date.now() + 5000);
  // Verified test status: the observed outcome of the last test command, next to the model's summary.
  const tested = new AgentViewState();
  tested.update({t:'done',status:'done',summary:'All tests pass.',tests:{status:'failed',command:'pytest tests/test_cli.py -q',exitCode:1,passed:57,failed:1,summary:'1 failed, 57 passed, 3 skipped in 0.18s'}});
  assert.equal(tested.status, 'All tests pass.');
  assert.equal(tested.tests, 'Tests (observed): 1 failed \u2014 1 failed, 57 passed, 3 skipped in 0.18s \u2014 $ pytest tests/test_cli.py -q');
  const passedState = new AgentViewState();
  passedState.update({t:'done',status:'done',tests:{status:'passed',command:'pytest -q',exitCode:0,passed:3,failed:0,summary:'3 passed in 0.1s'}});
  assert.equal(passedState.tests, 'Tests (observed): passed \u2014 3 passed in 0.1s \u2014 $ pytest -q');
  const staleState = new AgentViewState();
  staleState.update({t:'done',status:'done',summary:'All tests pass.',tests:{status:'failed',command:'pytest tests/test_cli.py -q',exitCode:1,failed:2,summary:'2 failed in 0.07s',editedAfter:['tests/test_cli.py']}});
  assert.equal(staleState.tests, 'Tests (observed): edited after last test run (last result: 2 failed \u2014 2 failed in 0.07s) \u2014 $ pytest tests/test_cli.py -q \u2014 changed since: tests/test_cli.py');
  const notRun = new AgentViewState();
  notRun.update({t:'done',status:'done',tests:{status:'not_run'}});
  assert.equal(notRun.tests, 'Tests (observed): not run in this turn');
  const inlineDone = new AgentViewState();
  inlineDone.update({t:'done',status:'done'});
  assert.equal(inlineDone.tests, '', 'no test line without done.tests (inline turns)');
  // Verification verdict at turn end: a turn that changed code is "Verified" only when the last observed test run passed
  // after the last edit; failing, stale or missing tests end as "Unverified" with the reason, and a contradicting reply is named.
  const changedTurn = (events) => {
    const v = new AgentViewState();
    v.update({t:'review_request',proposal:{path:'src/flask/cli.py',hunks:[{hunkId:'0'}]}});
    v.update({t:'edit_applied',result:{path:'src/flask/cli.py',status:'saved',appliedHunkIds:['0']}});
    for (const e of events) v.update(e);
    return v;
  };
  const failedRun = {status:'failed',command:'python -m pytest tests/test_cli.py -q',exitCode:1,failed:2,summary:'2 failed, 55 passed, 3 skipped in 0.14s'};
  const vFailed = changedTurn([{t:'text',delta:'Done. All tests pass.'},{t:'done',status:'done',summary:'Done. All tests pass.',tests:failedRun}]);
  assert.equal(vFailed.verification, '\u26a0 Unverified: the last test run failed (2 failed, 55 passed, 3 skipped in 0.14s). The reply says the tests pass; the observed result does not back that. Review the changes and run the tests before relying on them.');
  const vStale = changedTurn([{t:'done',status:'done',tests:{...failedRun,editedAfter:['tests/test_cli.py']}}]);
  assert.match(vStale.verification, /^\u26a0 Unverified: tests\/test_cli\.py changed after the last test run\./);
  const vNone = changedTurn([{t:'done',status:'done',tests:{status:'not_run'}}]);
  assert.match(vNone.verification, /^\u26a0 Unverified: code changed, but no test ran in this turn\./);
  const vOk = changedTurn([{t:'text',delta:'57 passed'},{t:'done',status:'done',tests:{status:'passed',command:'pytest -q',exitCode:0,passed:57,summary:'57 passed in 0.2s'}}]);
  assert.equal(vOk.verification, '\u2713 Verified: the last test run passed after the last edit');
  const vNoChange = new AgentViewState();
  vNoChange.update({t:'done',status:'done',tests:{status:'not_run'}});
  assert.equal(vNoChange.verification, '', 'nothing changed: no verdict');
  const vError = changedTurn([{t:'done',status:'error',tests:failedRun}]);
  assert.equal(vError.verification, '', 'an error or cancelled turn already says so; no verdict');
  const vInline = changedTurn([{t:'done',status:'done'}]);
  assert.equal(vInline.verification, '', 'inline turns carry no test outcome: no verdict');
  // Context report at a glance: pins first, one row per automatic file (rank order), skipped items grouped by reason.
  const { contextView, skipCategory } = require('../out/contextView');
  const grouped = contextView({budgetTokens:4000, estimatedTokens:3992,
    selections:[
      {path:'src/flask/cli.py',source:'automatic',rank:1,rationale:'BM25 match: command, cli',estimatedTokens:600,truncated:true,range:{startLine:1080,endLine:1130}},
      {path:'src/flask/helpers.py',source:'explicit',rank:0,rationale:'@file reference',estimatedTokens:300,truncated:false},
      {path:'src/flask/cli.py',source:'automatic',rank:3,rationale:'symbol: FlaskGroup',estimatedTokens:120,truncated:false,symbol:'FlaskGroup'},
      {path:'tests/test_cli.py',source:'automatic',rank:2,rationale:'test for src/flask/cli.py',estimatedTokens:110,truncated:false}],
    skipped:[
      {path:'src/flask/app.py',reason:'ranked #9 (score 3.1 vs top 9.0), below the cut of 8 files',estimatedTokens:0},
      {path:'docs/api.rst',reason:'lines 10-90 skipped: budget exhausted (needs 700, 40 left)',estimatedTokens:700},
      {path:'docs/config.rst',reason:'outline does not fit the remaining budget (40 tokens left)',estimatedTokens:90},
      {path:'.env',reason:'credentials file is not sent to the model',estimatedTokens:0}]});
  assert.deepEqual(grouped.pinned, ['src/flask/helpers.py \u2014 pinned, outline, 300 tokens']);
  assert.deepEqual(grouped.files, [
    'src/flask/cli.py \u2014 lines 1080\u20131130, FlaskGroup \u2014 720 tokens \u2014 BM25 match: command, cli (+1 more) (truncated)',
    'tests/test_cli.py \u2014 outline \u2014 110 tokens \u2014 test for src/flask/cli.py']);
  assert.deepEqual(grouped.skipped, [
    'Ranked below the file cut \u2014 1 item: src/flask/app.py',
    'Did not fit the token budget \u2014 2 items: docs/api.rst, docs/config.rst (790 tokens)',
    'Refused by the read policy (never sent) \u2014 1 item: .env']);
  assert.equal(skipCategory('semantic reranking is warming in the background; lexical and structural ranking used for this turn'), 'Semantic reranking');
  const reported = new AgentViewState();
  reported.update({t:'context_report',report:{budgetTokens:4000,estimatedTokens:10,selections:[],skipped:[]}});
  assert.deepEqual(reported.contextView, {pinned:[],files:[],skipped:[]});
  // Stop: requested → settling (harness status detail) → stopped and settled, naming what changed before the stop.
  const stopping = new AgentViewState();
  stopping.update({t:'status',state:'cancelling',detail:'Stop requested: approvals closed; settling 1 tool call (an approved edit is saved and reported, a running command is killed)'});
  assert.match(stopping.status, /^Stop requested: approvals closed; settling 1 tool call/);
  stopping.update({t:'done',status:'cancelled'});
  assert.equal(stopping.status, 'Stopped \u00b7 settled: no change was applied in this turn; nothing else will run');
  const stoppedAfterEdit = changedTurn([{t:'done',status:'cancelled'}]);
  assert.equal(stoppedAfterEdit.status, 'Stopped \u00b7 settled: 1 file changed before the stop (listed below); nothing else will run');
  // Resume when ready: one scheduled Resume, only for the same resumable turn; Stop, a new turn or a second click cancel it.
  {
    let resumed = 0;
    const p = new AgentPanel({ send: async () => {}, stop: async () => {}, review() {}, command() {}, resume: async () => { resumed++; } });
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    p.event({t:'resumable',reason:'rate_limited',retryAfterMs:60,changedFiles:['src/flask/cli.py']});
    p.setAutoResume(true);
    assert.equal(p.state.autoResume, true);
    await wait(150);
    assert.equal(resumed, 1, 'resumed once when the wait ended');
    assert.equal(p.state.autoResume, false);
    await wait(100);
    assert.equal(resumed, 1, 'never twice');
    p.event({t:'resumable',reason:'rate_limited',retryAfterMs:60,changedFiles:[]});
    p.setAutoResume(true); p.setAutoResume(false);
    await wait(150);
    assert.equal(resumed, 1, 'a second click cancels it');
    p.event({t:'resumable',reason:'rate_limited',retryAfterMs:60,changedFiles:[]});
    p.setAutoResume(true); p.start();
    await wait(150);
    assert.equal(resumed, 1, 'a new turn cancels it');
    p.finish(); p.event({t:'resumable',reason:'stalled',retryAfterMs:60,changedFiles:[]});
    p.setAutoResume(true); p.state.resume = {at: Date.now() + 60, files: [], reason: 'stalled'};
    await wait(150);
    assert.equal(resumed, 1, 'a different resumable turn is not resumed by an older schedule');
    p.dispose();
  }
  // Destructive hunks: a hunk that deletes a whole class is listed with its name and line count.
  const destructive = new AgentViewState();
  destructive.update({t:'review_request',proposal:{path:'tests/test_cli.py',originalText:'import x\n\nclass TestRoutes:\n    pass\n',hunks:[
    {hunkId:'a',startOffset:0,endOffset:0,oldText:'',newText:'# c\n'},
    {hunkId:'b',startOffset:10,endOffset:34,oldText:'class TestRoutes:\n    pass',newText:'class TestConfig:\n    pass',deletes:[{kind:'class',name:'TestRoutes',lines:25}]}]}});
  assert.deepEqual(destructive.warnings, ['tests/test_cli.py: Hunk 2 (line 3) deletes class TestRoutes (25 lines)']);
  const { proposalWarnings, hunkWarning } = require('../out/destructive');
  assert.equal(hunkWarning({deletes:[{kind:'function',name:'a',lines:3},{kind:'function',name:'b',lines:2}]}), 'deletes function a (3 lines), function b (2 lines)');
  assert.deepEqual(proposalWarnings({originalText:'x',hunks:[{hunkId:'a',startOffset:0}]}), []);
  const compact = new AgentViewState();
  compact.update({t:'status',state:'compacting',detail:'Compacting context: 30,412 tokens reached the 30,000-token threshold'});
  assert.equal(compact.status, 'Compacting context: 30,412 tokens reached the 30,000-token threshold', 'compaction start on the status line');
  compact.update({t:'status',state:'running',detail:'Context compacted in 21.4 s: 29,880 tokens summarized into 1,204'});
  assert.equal(compact.status, 'Context compacted in 21.4 s: 29,880 tokens summarized into 1,204', 'compaction finish on the status line');
  compact.update({t:'status',state:'running'});
  assert.deepEqual(compact.tools, [{id:'compaction:0',label:'Context compaction',detail:'Context compacted in 21.4 s: 29,880 tokens summarized into 1,204'}],
    'the compaction stays in the activity list after the status line moves on');
  // Turn-end summary: every changed file with review and accepted-hunk counts; reviewed-but-rejected files last.
  const turn = new AgentViewState();
  const prop = (path, n) => ({t:'review_request',proposal:{path,hunks:Array.from({length:n},(_, i)=>({hunkId:String(i)}))}});
  const applied = (path, ids, status = 'saved') => ({t:'edit_applied',result:{path,status,appliedHunkIds:ids}});
  turn.update(prop('src/a.py',2)); turn.update(applied('src/a.py',['0','1']));
  turn.update(prop('docs/b.rst',3)); turn.update({t:'edit_applied',result:{path:'docs/b.rst',status:'approval_missing'}});
  turn.update(prop('tests/c.py',1)); turn.update(applied('tests/c.py',['0']));
  turn.update(prop('src/a.py',1)); turn.update(applied('src/a.py',['0']));
  assert.deepEqual(turn.summary, [], 'no summary while the turn runs');
  turn.update({t:'done',status:'done'});
  assert.deepEqual(turn.summary, ['src/a.py | 2 reviews, 3/3 hunks accepted | saved', 'tests/c.py | 1 review, 1/1 hunks accepted | saved',
    'docs/b.rst | 1 review, 0/3 hunks accepted | not changed']);
  const state = new AgentViewState();
  const folder = vscode.workspace.workspaceFolders[0];
  const selected = {path:'src/a',source:'automatic',rank:1,rationale:'entry point',estimatedTokens:6,truncated:false};
  const skipped = {path:'other/a',reason:'over budget',estimatedTokens:11};
  const report = {budgetTokens:10,estimatedTokens:6,selections:[selected],skipped:[skipped]};
  const version = require('forge-harness').PROTOCOL_VERSION;
  let releaseCommand; const commandAnswered=new Promise(resolve=>releaseCommand=resolve);
  let command, submitted = false, marked = false;
  const harness = {
    start:async port => {assert.equal(typeof port.applyText,'function')},
    createSession:async()=>({ok:true,body:{sessionId:'sim'}}),
    submitTurn:async ({body})=>{submitted=true;assert.equal(body.instruction,'simulated task');assert.equal(body.autoApproveSafeCommands,undefined,'off by default');assert.equal(body.commandBudget,3,'agent budget defaults to 3 (forge.commandBudget.agent)');return {ok:true,body}},
    stream:async function*({body}) {
      const header = {version, sessionId:body.sessionId,turnId:body.turnId};
      let sequence = 0;
      for (const e of [
        {t:'turn_started'}, {t:'text',messageId:'1',delta:'hello '},{t:'text',messageId:'1',delta:'world'},
        {t:'tool_call',tool:'internal',callId:'sys',displayName:'list_tools',summary:'internal'},
        {t:'tool_call',tool:'context',callId:'ctx',displayName:'gather_context',summary:'discovery'},
        {t:'tool_result',callId:'ctx',ok:true,summary:'one selected'},
        {t:'context_report',report}, {t:'fallback',fromModel:'primary',toModel:'backup',reason:'unreachable'},
        {t:'command_request',callId:'shell',command:'python --version',cwd:'.'},
        {t:'error',error:{message:'Simulated model failure',workspaceEffect:'unchanged'}},
        {t:'done',status:'error'}])
        { yield {ok:true,body:{...header,...e,sequence:++sequence}}; if(e.t==='command_request') await commandAnswered; }
    },
    submitReview:async({body})=>{command=body;releaseCommand();return {ok:true,body:null}},
    dispose:async()=>{marked=true}
  };
  const wb = new Workbench(folder,()=>({version,harness}));
  const seen = [];
  const original = wb.events.bind(wb);
  wb.events=e=>{seen.push(e);state.update(e);original(e)};
  wb.showPanel();
  const run = wb.run('agent','simulated task',{});
  try {
    await until(()=>seen.some(e=>e.t==='command_request'));
    assert.equal(state.text,'hello world');
    assert.deepEqual(state.tools,[{id:'ctx',label:'gather_context',detail:'Done: one selected'}]);
    assert.deepEqual(state.context,report);
    assert.match(state.banner,/unreachable.*backup/);
    assert.equal(state.recovery,'primary \u2192 backup \u2014 reason: unreachable. The turn restarted on the fallback model in a fresh TrueForge session (its own trace). The failed attempt changed no files: Forge falls back only before any edit or command has taken effect.');
    assert.equal(wb.reviewControlsOpen(),false,'a command approval does not open edit-review controls');
    wb.choose(); wb.decideAll('accept');
    await delay(50);
    assert.equal(command,undefined,'review controls cannot answer the pending command approval');
    await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
    await Promise.race([run,delay(5000).then(()=>{throw Error('Command decision timed out')})]);
    assert.equal(submitted,true);
    assert.equal(command.allow,false); assert.equal(command.callId,'shell'); assert.equal(command.kind,'command');
    assert.match(state.banner,/Simulated model failure.*unchanged/); assert.equal(state.status,'error');
  } finally { await wb.shutdown(); }
  assert.ok(marked);

  // forge.autoApproveSafeCommands on: the request carries it; an auto-approved command opens no prompt and
  // sends no decision, while an unrestricted command in the same turn still asks.
  const forgeCfg = vscode.workspace.getConfiguration('forge');
  assert.equal(forgeCfg.inspect('commandBudget.agent').defaultValue, 3);
  assert.equal(forgeCfg.inspect('commandBudget.inline').defaultValue, 1);
  await forgeCfg.update('autoApproveSafeCommands', true, vscode.ConfigurationTarget.Global);
  await forgeCfg.update('commandBudget.agent', 2, vscode.ConfigurationTarget.Global);
  try {
    let turnBody, decisions = [], releaseAsk; const askAnswered = new Promise(r => releaseAsk = r);
    const autoHarness = {...harness,
      submitTurn:async({body})=>{turnBody=body;return {ok:true,body}},
      stream:async function*({body}) {
        const h={version,sessionId:body.sessionId,turnId:body.turnId}; let s=0;
        for (const e of [{t:'turn_started'},
          {t:'command_request',callId:'auto1',command:'python -m pytest tests/test_x.py -q',cwd:'.',autoApproved:true},
          {t:'command_request',callId:'ask1',command:'rm -rf build',cwd:'.',unrestricted:true,warning:'Unrestricted command'},
          {t:'done',status:'done'}]) {
          yield {ok:true,body:{...h,...e,sequence:++s}};
          if (e.callId === 'ask1') await askAnswered;
        }
      },
      submitReview:async({body})=>{decisions.push(body);releaseAsk();return {ok:true,body:null}},
      dispose:async()=>{}};
    const wb2 = new Workbench(folder,()=>({version,harness:autoHarness}));
    const seen2 = [], state2 = new AgentViewState();
    const original2 = wb2.events.bind(wb2);
    wb2.events=e=>{seen2.push(e);state2.update(e);original2(e)};
    const run2 = wb2.run('agent','simulated task',{});
    try {
      await until(()=>seen2.some(e=>e.callId==='ask1'));
      assert.equal(turnBody.autoApproveSafeCommands, true, 'the setting reaches the harness');
      assert.equal(turnBody.commandBudget, 2, 'forge.commandBudget.agent reaches the harness');
      assert.ok(state2.tools.some(t=>t.label==='auto-approved: python -m pytest tests/test_x.py -q'), 'visible in the panel');
      await delay(200);
      assert.equal(decisions.length, 0, 'nothing was sent for the auto-approved command');
      await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');  // the unrestricted one still asks (Deny)
      await Promise.race([run2,delay(5000).then(()=>{throw Error('auto-approve run timed out')})]);
      assert.deepEqual(decisions.map(d=>[d.callId,d.allow]), [['ask1',false]], 'only the unrestricted command was decided by the user');
    } finally { await wb2.shutdown(); }
  } finally {
    await forgeCfg.update('autoApproveSafeCommands', undefined, vscode.ConfigurationTarget.Global);
    await forgeCfg.update('commandBudget.agent', undefined, vscode.ConfigurationTarget.Global);
  }

  // Resume after a rate limit: the controller remembers the turn; Workbench.resume() resubmits the same instruction
  // and context in the same conversation with resumeOf. Both budgets reach the harness (test budget default 3).
  {
    const bodies = [];
    const resumeHarness = {...harness,
      submitTurn:async({body})=>{bodies.push(body);return {ok:true,body}},
      stream:async function*({body}) {
        const h={version,sessionId:body.sessionId,turnId:body.turnId}; let s=0;
        const events = bodies.length === 1
          ? [{t:'turn_started'},{t:'resumable',reason:'rate_limited',retryAfterMs:0,changedFiles:['src/a.py']},
            {t:'error',error:{code:'unavailable',message:'Model unavailable: [Model Error] Request failed (429)',retryable:false,workspaceEffect:'changed'}},{t:'done',status:'error'}]
          : [{t:'turn_started'},{t:'done',status:'done'}];
        for (const e of events) yield {ok:true,body:{...h,...e,sequence:++s}};
      },
      dispose:async()=>{}};
    const wb3 = new Workbench(folder,()=>({version,harness:resumeHarness}));
    const state3 = new AgentViewState(); const original3 = wb3.events.bind(wb3);
    wb3.events=e=>{state3.update(e);original3(e)};
    try {
      await wb3.run('agent','resumable task',{activeFile:'src/a.py'});
      assert.deepEqual(state3.resume.files, ['src/a.py'], 'the panel offers Resume');
      assert.equal(bodies[0].testCommandBudget, 3, 'forge.testCommandBudget.agent defaults to 3 and reaches the harness');
      assert.equal(bodies[0].commandBudget, 3);
      assert.equal(bodies[0].resumeOf, undefined);
      await wb3.resume();
      assert.equal(bodies.length, 2);
      assert.equal(bodies[1].resumeOf, bodies[0].turnId, 'resumeOf names the interrupted turn');
      assert.equal(bodies[1].instruction, 'resumable task');
      assert.equal(bodies[1].sessionId, bodies[0].sessionId, 'same conversation');
      assert.equal(bodies[1].activeFile, 'src/a.py');
      await wb3.resume();
      assert.equal(bodies.length, 2, 'nothing to resume once the resumed turn ran');
    } finally { await wb3.shutdown(); }
  }

  const gate = new EditReview(folder);
  let cancelled=false, start, go;
  const ready=new Promise(r=>start=r), released=new Promise(r=>go=r);
  const displayed=[];
  const slow={...harness,submitTurn:async({body})=>({ok:true,body}),stream:async function*({body}) {
    const h={version,sessionId:body.sessionId,turnId:body.turnId};
    yield {ok:true,body:{...h,sequence:1,t:'turn_started'}};start();
    await released;
    yield {ok:true,body:{...h,sequence:2,t:'text',messageId:'1',delta:'late'}};
    yield {ok:true,body:{...h,sequence:3,t:'done',status:'cancelled'}};
  },cancel:async()=>{cancelled=true;go();return {ok:true,body:'confirmed'}}};
  const ctrl=new TurnController(slow,version,folder.uri.fsPath,gate,{event:e=>displayed.push(e.t),
    review:async()=>undefined,command:async()=>false,cancelReview(){},notice(){}});
  const slowRun=ctrl.run('agent','stop',{});
  await ready;await ctrl.stop();await slowRun;
  assert.ok(cancelled);assert.deepEqual(displayed,['turn_started','done']);gate.dispose();
  console.log('PASS simulated panel stream, tool summaries, selection/skips, fallback/error, command denial, Stop and late-event filtering, test budget, sub-agents, Resume (rate limit and stall), observed test status (incl. stale), destructive-hunk warnings');
};
