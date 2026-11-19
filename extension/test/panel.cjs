const assert = require('node:assert/strict');
const vscode = require('vscode');
const { AgentViewState } = require('../out/agentPanel');
const { Workbench } = require('../out/workbench');
const { TurnController } = require('../out/turn');
const { EditReview } = require('../out/review');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async condition => {
  for (let i = 0; i < 150; i++) { if (await condition()) return; await delay(40); }
  throw Error('Timed out waiting for UI');
};
exports.run = async () => {
  await require('./review.cjs').run();
  const flagged = new AgentViewState();
  flagged.update({t:'command_request',callId:'x',command:'rm -rf build',cwd:'.',unrestricted:true,warning:'Unrestricted command: it can change any file without hunk review and is not sandboxed.'});
  assert.match(flagged.command.warning, /without hunk review/, 'the panel carries the unrestricted warning');
  flagged.update({t:'command_request',callId:'y',command:'pytest -q',cwd:'.'});
  assert.equal(flagged.command.warning, undefined, 'listed commands carry no warning');
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
    submitTurn:async ({body})=>{submitted=true;assert.equal(body.instruction,'simulated task');assert.equal(body.autoApproveSafeCommands,undefined,'off by default');assert.equal(body.commandBudget,3,'agent budget defaults to 3');return {ok:true,body}},
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
  console.log('PASS simulated panel stream, tool summaries, selection/skips, fallback/error, command denial, Stop and late-event filtering');
};
