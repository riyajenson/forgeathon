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
  const state = new AgentViewState();
  const folder = vscode.workspace.workspaceFolders[0];
  const selected = {path:'src/a',source:'automatic',rank:1,rationale:'entry point',estimatedTokens:6,truncated:false};
  const skipped = {path:'other/a',reason:'over budget',estimatedTokens:11};
  const report = {budgetTokens:10,estimatedTokens:6,selections:[selected],skipped:[skipped]};
  const version = '0.4.0';
  let releaseCommand; const commandAnswered=new Promise(resolve=>releaseCommand=resolve);
  let command, submitted = false, marked = false;
  const harness = {
    start:async port => {assert.equal(typeof port.applyText,'function')},
    createSession:async()=>({ok:true,body:{sessionId:'sim'}}),
    submitTurn:async ({body})=>{submitted=true;assert.equal(body.instruction,'simulated task');return {ok:true,body}},
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
