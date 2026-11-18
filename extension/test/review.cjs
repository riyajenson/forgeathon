const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const vscode=require('vscode');
const {EditReview,hash}=require('../out/review');
const {TurnController}=require('../out/turn');
exports.run=async()=>{
  await require('./editorPort.cjs').run();
  const folder=vscode.workspace.workspaceFolders[0], root=folder.uri.fsPath;
  const dir=await fs.mkdtemp(path.join(root,'review-'));
  const local=path.basename(dir)+'/task.py', file=path.join(dir,'task.py');
  const ref={sessionId:'sim-session',turnId:'sim-turn',callId:'tool',proposalId:'p'};
  const original='one\ntwo\n', replacement='ONE\ntwo\n';
  await fs.writeFile(file,original);
  const make=(extra={})=>({...ref,kind:'proposal',path:local,isNewFile:false,baseSha256:hash(original),
    originalText:original,proposedText:'ONE\nTWO\n',summary:'Simulated change',hunks:[
    {hunkId:'a',startOffset:0,endOffset:3,oldText:'one',newText:'ONE'},
    {hunkId:'b',startOffset:4,endOffset:7,oldText:'two',newText:'TWO'}],...extra});
  const request=(p,changes={})=>({...ref,sessionId:p.sessionId,turnId:p.turnId,proposalId:p.proposalId,callId:p.callId,kind:'apply_approved',path:local,
    expectedSha256:p.baseSha256,text:replacement,textSha256:hash(replacement),acceptedHunkIds:['a'],...changes});
  const edits=new EditReview(folder), p=make();
  const check=async(status,payload)=>assert.equal((await edits.applyText(payload)).status,status);
  edits.begin(p);
  await check('approval_missing',request(p));
  edits.decide(p,{a:'reject',b:'reject'});
  await check('approval_missing',request(p));
  assert.equal(await fs.readFile(file,'utf8'),original);
  edits.decide(p,{a:'accept',b:'reject'});
  await check('approval_missing',request(p,{acceptedHunkIds:['b']}));
  await check('approval_missing',request(p,{text:'anything else',textSha256:hash('anything else')}));
  edits.end();
  await check('approval_missing',request(p));
  edits.begin(p);
  edits.decide(p,{a:'accept',b:'reject'});
  await fs.writeFile(file,'external');
  await check('stale',request(p));
  assert.equal(await fs.readFile(file,'utf8'),'external');
  await fs.writeFile(file,original);
  edits.end();
  let decision,result,recordDecision;
  const decisionReady = new Promise(resolve=>recordDecision=resolve);
  const version='0.4.0', events=[];
  const harness={
    createSession:async()=>({ok:true,body:{sessionId:'s'}}), submitTurn:async({body})=>({ok:true,body}),
    stream:async function*({body}) {
      const header={turnId:body.turnId,sessionId:body.sessionId,version};
      const proposal=make(header);
      yield {ok:true,body:{...header,sequence:1,t:'review_request',proposal}};
      await decisionReady;
      assert.deepEqual(decision.hunks,{a:'accept',b:'reject'});
      result=await edits.applyText(request(proposal));
      yield {ok:true,body:{...header,sequence:2,t:'edit_applied',result}};
      yield {ok:true,body:{...header,sequence:3,t:'done',status:'done'}};
    },
    submitReview:async({body})=>{decision=body;recordDecision();return {ok:true,body:null}},
    closeSession:async()=>({ok:true,body:{}}),cancel:async()=>({ok:true,body:'confirmed'})
  };
  const ui={event:e=>events.push(e.t),review:async proposal=>edits.decide(proposal,{a:'accept',b:'reject'}),
    notice:()=>{},cancelReview:()=>{},command:async()=>false};
  await new TurnController(harness,version,root,edits,ui).run('inline','test only',{});
  assert.deepEqual(events,['review_request','edit_applied','done']);
  assert.equal(result.status,'saved');
  assert.equal(await fs.readFile(file,'utf8'),replacement);
  assert.equal(result.undo.expectedPostSha256,hash(replacement));
  await edits.undo(result.undo.undoId);
  assert.equal(await fs.readFile(file,'utf8'),original);
  const failing=new EditReview(folder,async()=>false);
  failing.begin(p); failing.decide(p,{a:'accept',b:'reject'});
  const failure=await failing.applyText(request(p));
  assert.equal(failure.status,'save_failed');
  assert.deepEqual(await failing.applyText(request(p)),failure);
  assert.equal((await failing.readText(local)).text,replacement);
  assert.equal(await fs.readFile(file,'utf8'),original);
  await failing.undo(failure.undo.undoId);
  const doc=await vscode.workspace.openTextDocument(vscode.Uri.file(file));
  const dirty=new vscode.WorkspaceEdit();
  dirty.insert(doc.uri,new vscode.Position(0,0),'# ');
  assert.ok(await vscode.workspace.applyEdit(dirty));
  const dirtyBase=doc.getText();
  const d=make({originalText:dirtyBase,baseSha256:hash(dirtyBase),proposedText:'note\n'+dirtyBase,
    hunks:[{hunkId:'a',startOffset:0,endOffset:0,oldText:'',newText:'note\n'}]});
  edits.begin(d); edits.decide(d,{a:'accept'});
  const deferred=await edits.applyText(request(d,{text:d.proposedText,textSha256:hash(d.proposedText)}));
  assert.equal(deferred.status,'buffer_applied'); assert.equal(await fs.readFile(file,'utf8'),original);
  const extra=new vscode.WorkspaceEdit(); extra.insert(doc.uri,new vscode.Position(0,0),'later ');
  assert.ok(await vscode.workspace.applyEdit(extra));
  await assert.rejects(edits.undo(deferred.undo.undoId),/changed/);
  const fresh=make({proposalId:'new',callId:'new',path:path.basename(dir)+'/new.py',isNewFile:true,baseSha256:null,originalText:'',proposedText:'new',
    hunks:[{hunkId:'a',startOffset:0,endOffset:0,oldText:'',newText:'new'}]});
  edits.begin(fresh); edits.decide(fresh,{a:'accept'});
  await check('failed_before_apply',request(fresh,{path:fresh.path,text:'new',textSha256:hash('new')}));
  edits.dispose(); failing.dispose();
  console.log('PASS simulated turn, all six apply outcomes, partial approval, cancel gate, guarded undo, replay after save failure');
};
