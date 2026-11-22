const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const vscode=require('vscode');
const {EditReview,hash}=require('../out/review');
const {InlineReview}=require('../out/inlineReview');
const {TurnController}=require('../out/turn');
function fakeQuickPick(){
  const accepts=[], hides=[], buttons=[], selectionChanges=[];
  return {
    items:[], selectedItems:[], buttons:[], canSelectMany:false, acceptCount:0, hidden:false, disposed:false,
    onDidAccept(fn){accepts.push(fn);return {dispose(){}};},
    onDidHide(fn){hides.push(fn);return {dispose(){}};},
    onDidTriggerButton(fn){buttons.push(fn);return {dispose(){}};},
    onDidChangeSelection(fn){selectionChanges.push(fn);return {dispose(){}};},
    show(){this.hidden=false;},
    hide(){if(this.hidden)return;this.hidden=true;for(const fn of hides)fn();},
    dispose(){this.disposed=true;},
    accept(){this.acceptCount++;for(const fn of accepts)fn();},
    changeSelection(items){this.selectedItems=items;for(const fn of selectionChanges)fn(items);},
    triggerButton(button){for(const fn of buttons)fn(button);}
  };
}
async function directPickerChecks(){
  const originalCreateQuickPick=vscode.window.createQuickPick;
  const originalExecuteCommand=vscode.commands.executeCommand;
  const originalRegisterProvider=vscode.workspace.registerTextDocumentContentProvider;
  const originalOnDidClose=vscode.workspace.onDidCloseTextDocument;
  const picks=[], diffCalls=[], providers=[], closeHandlers=[];
  vscode.window.createQuickPick=()=>{const picker=fakeQuickPick();picks.push(picker);return picker;};
  vscode.workspace.registerTextDocumentContentProvider=(scheme,provider)=>{
    providers.push({scheme,provider});
    return {dispose(){}};
  };
  vscode.workspace.onDidCloseTextDocument=handler=>{closeHandlers.push(handler);return {dispose(){}};};
  vscode.commands.executeCommand=async(command,...args)=>{
    if(command==='vscode.diff'){diffCalls.push(args);return undefined;}
    return originalExecuteCommand.call(vscode.commands,command,...args);
  };
  const original='one\ntwo\n', proposed='ONE\nTWO\n';
  const proposal={sessionId:'s',turnId:'t',callId:'c',proposalId:'direct',kind:'proposal',path:'src/task.py',
    originalText:original,proposedText:proposed,hunks:[
      {hunkId:'a',startOffset:0,endOffset:3,oldText:'one',newText:'ONE'},
      {hunkId:'b',startOffset:4,endOffset:7,oldText:'two',newText:'TWO'}]};
  const decisions=[];
  let active=true;
  const edits={isActive:()=>active,decide:(_p,hunks)=>{decisions.push(hunks);return {proposalId:proposal.proposalId,hunks};}};
  const settle=()=>new Promise(resolve=>setTimeout(resolve,0));
  try{
    const review=new InlineReview(edits), pending=review.request(proposal);
    await settle();
    const picker=picks[0];
    const provider=providers.at(-1).provider, right=diffCalls[0][1];
    assert.equal(typeof provider.onDidChange,'function','the open diff provider can signal live content changes');
    const changedUris=[];
    provider.onDidChange(uri=>changedUris.push(uri.toString()));
    assert.equal(provider.provideTextDocumentContent(right),proposed,'the initial preview contains all proposed hunks');
    assert.equal(picks.length,1,'choosing one hunk opens one picker instead of the former action menu plus hunk picker');
    assert.equal(picker.canSelectMany,true,'each hunk has its own checkbox');
    assert.match(picker.title,/diff updates as you check them/i,'the live editor preview is discoverable');
    assert.deepEqual(picker.items.map(item=>item.hunkId),['a','b'],'the direct picker exposes every hunk');
    assert.deepEqual(picker.buttons.map(button=>button.tooltip),['Accept all hunks','Reject all hunks']);
    const expected=['one\ntwo\n','ONE\ntwo\n','one\nTWO\n','ONE\nTWO\n'];
    let exactLivePreviews=0, exactBaselinePreviews=0;
    for(let mask=0;mask<4;mask++){
      const selected=picker.items.filter((_item,index)=>mask&(1<<index));
      const changesBefore=changedUris.length;
      picker.changeSelection(selected);
      const shown=provider.provideTextDocumentContent(right);
      assert.equal(shown,expected[mask],
        `the editor diff previews exactly the accepted subset for selection mask ${mask}`);
      assert.equal(changedUris.length,changesBefore+1,'each changed selection invalidates the open proposed-side document');
      if(shown===expected[mask])exactLivePreviews++;
      if(proposed===expected[mask])exactBaselinePreviews++;
      assert.equal(changedUris.at(-1),right.toString(),'updates target the open proposed-side URI');
    }
    assert.equal(exactLivePreviews,4);
    assert.equal(exactBaselinePreviews,1);
    console.log(`Inline diff preview-state benchmark: baseline ${exactBaselinePreviews}/4 (25%); live ${exactLivePreviews}/4 (100%); 4x coverage`);
    picker.changeSelection([picker.items[1]]);
    picker.accept();
    assert.equal(picker.acceptCount,1,'a partial decision needs one submit action');
    assert.deepEqual((await pending).hunks,{a:'reject',b:'accept'});
    assert.equal(provider.provideTextDocumentContent(right),'one\nTWO\n',
      'the accepted-subset preview remains available while its diff tab is open');
    closeHandlers.at(-1)({uri:diffCalls[0][0]});
    closeHandlers.at(-1)({uri:right});
    assert.equal(provider.provideTextDocumentContent(right),'','closed preview documents release their cached contents');
    assert.equal(picker.hidden,true,'accept closes the picker');
    assert.equal(review.open,false);
    assert.deepEqual(decisions[0],{a:'reject',b:'accept'});
    review.dispose();

    for(const [buttonIndex,choice] of [[0,'accept'],[1,'reject']]){
      const allReview=new InlineReview(edits), allPending=allReview.request(proposal);
      await settle();
      const allPicker=picks.at(-1);
      allPicker.triggerButton(allPicker.buttons[buttonIndex]);
      const allProvider=providers.at(-1).provider, allRight=diffCalls.at(-1)[1];
      assert.equal(allProvider.provideTextDocumentContent(allRight),choice==='accept'?proposed:original,
        `${choice} all leaves the editor diff showing the exact decision result`);
      assert.deepEqual((await allPending).hunks,{a:choice,b:choice});
      assert.equal(allPicker.hidden,true,'Accept All and Reject All close the picker');
      allReview.dispose();
    }

    const staleReview=new InlineReview(edits), stale=staleReview.request(proposal);
    await settle();
    const stalePicker=picks.at(-1);
    active=false;
    stalePicker.triggerButton(stalePicker.buttons[0]);
    const staleControlsOpen=staleReview.open;
    staleReview.cancel();
    assert.equal(staleControlsOpen,false,'a stale proposal closes review controls');
    assert.equal(await stale,undefined);
    staleReview.dispose();
    active=true;

    const cancelledReview=new InlineReview(edits), cancelled=cancelledReview.request(proposal);
    await settle();
    const cancelledPicker=picks.at(-1);
    cancelledReview.cancel();
    assert.equal(await cancelled,undefined);
    assert.equal(cancelledPicker.hidden,true,'cancel closes the picker');
    assert.equal(cancelledReview.open,false,'cancel removes every review control');
    cancelledReview.dispose();

    const failedReview=new InlineReview({...edits,decide(){throw new Error('decision failed');}});
    const failed=failedReview.request(proposal);
    await settle();
    const failedPicker=picks.at(-1);
    failedPicker.accept();
    await assert.rejects(failed,/decision failed/);
    assert.equal(failedPicker.hidden,true,'decision errors close the picker');
    assert.equal(failedReview.open,false,'decision errors remove the pending review controls');
    failedReview.dispose();
  }finally{
    vscode.window.createQuickPick=originalCreateQuickPick;
    vscode.commands.executeCommand=originalExecuteCommand;
    vscode.workspace.registerTextDocumentContentProvider=originalRegisterProvider;
    vscode.workspace.onDidCloseTextDocument=originalOnDidClose;
  }
}
exports.run=async()=>{
  await directPickerChecks();
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
  const version=require('forge-harness').PROTOCOL_VERSION, events=[];
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
  // Benchmark hunk-level application against the previous whole-document replacement.
  {
    const largePath=path.join(dir,'surgical.py'), largeLocal=path.basename(dir)+'/surgical.py';
    const stable=Array.from({length:5000},(_,i)=>`# stable line ${i}\n`).join('');
    const oldTexts=['first_old = 1','second_old = 2','third_old = 3'];
    const newTexts=['first_new_value = 1','second_new = 2','third_new = 3'];
    const largeOriginal=stable+oldTexts.map(text=>`\n${text}\n`).join('');
    const hunks=oldTexts.map((oldText,i)=>{
      const startOffset=largeOriginal.indexOf(oldText);
      return {hunkId:['a','b','c'][i],startOffset,endOffset:startOffset+oldText.length,oldText,newText:newTexts[i]};
    });
    let fullProposal=largeOriginal;
    for(const h of [...hunks].reverse()) fullProposal=fullProposal.slice(0,h.startOffset)+h.newText+fullProposal.slice(h.endOffset);
    let reviewedText=largeOriginal;
    for(const h of [...hunks].filter(h=>h.hunkId!=='b').reverse()) reviewedText=reviewedText.slice(0,h.startOffset)+h.newText+reviewedText.slice(h.endOffset);
    await fs.writeFile(largePath,largeOriginal);
    const largeProposal=make({proposalId:'surgical',callId:'surgical',path:largeLocal,baseSha256:hash(largeOriginal),
      originalText:largeOriginal,proposedText:fullProposal,hunks});
    edits.begin(largeProposal);
    edits.decide(largeProposal,{a:'accept',b:'reject',c:'accept'});
    const largeDoc=await vscode.workspace.openTextDocument(vscode.Uri.file(largePath));
    const originalReplace=vscode.WorkspaceEdit.prototype.replace;
    const originalApplyEdit=vscode.workspace.applyEdit;
    const submitted=[];
    let applyCount=0, applied;
    vscode.WorkspaceEdit.prototype.replace=function(uri,range,text,...rest){
      if(uri.toString()===largeDoc.uri.toString()) submitted.push({start:largeDoc.offsetAt(range.start),end:largeDoc.offsetAt(range.end),text});
      return originalReplace.call(this,uri,range,text,...rest);
    };
    vscode.workspace.applyEdit=async function(edit,...args){applyCount++;return originalApplyEdit.call(vscode.workspace,edit,...args);};
    try {
      applied=await edits.applyText(request(largeProposal,{path:largeLocal,text:reviewedText,textSha256:hash(reviewedText),acceptedHunkIds:['a','c']}));
    } finally {
      vscode.WorkspaceEdit.prototype.replace=originalReplace;
      vscode.workspace.applyEdit=originalApplyEdit;
    }
    assert.equal(applied.status,'saved');
    const accepted=hunks.filter(h=>h.hunkId!=='b');
    assert.deepEqual(submitted,accepted.map(h=>({start:h.startOffset,end:h.endOffset,text:h.newText})),
      'the one atomic editor transaction contains only the accepted hunk ranges');
    assert.equal(applyCount,1,'all accepted hunks are applied in one VS Code transaction');
    const footprint=submitted.reduce((n,e)=>n+(e.end-e.start)+e.text.length,0);
    const fullDocumentFootprint=largeOriginal.length+reviewedText.length;
    const improvement=1-footprint/fullDocumentFootprint;
    assert.ok(improvement>=0.5,'accepted-hunk edit footprint is at least 50% below the full-document baseline');
    assert.equal(largeDoc.getText(),reviewedText,'the rejected middle hunk remains unchanged');
    const inverseExpected=[];
    let offsetDelta=0;
    for(const h of accepted){
      const start=h.startOffset+offsetDelta;
      inverseExpected.push({start,end:start+h.newText.length,textLength:h.oldText.length});
      offsetDelta+=h.newText.length-(h.endOffset-h.startOffset);
    }
    const undoSubmitted=[];
    let undoApplyCount=0;
    const replaceForUndo=vscode.WorkspaceEdit.prototype.replace;
    const applyForUndo=vscode.workspace.applyEdit;
    vscode.WorkspaceEdit.prototype.replace=function(uri,range,text,...rest){
      if(uri.toString()===largeDoc.uri.toString()) undoSubmitted.push({
        start:largeDoc.offsetAt(range.start),end:largeDoc.offsetAt(range.end),textLength:text.length
      });
      return replaceForUndo.call(this,uri,range,text,...rest);
    };
    vscode.workspace.applyEdit=async function(edit,...args){undoApplyCount++;return applyForUndo.call(vscode.workspace,edit,...args);};
    try { await edits.undo(applied.undo.undoId); }
    finally {
      vscode.WorkspaceEdit.prototype.replace=replaceForUndo;
      vscode.workspace.applyEdit=applyForUndo;
    }
    assert.deepEqual(undoSubmitted,inverseExpected,'undo uses inverse ranges mapped through earlier accepted hunk length changes');
    assert.equal(undoApplyCount,1,'all inverse hunks are restored in one VS Code transaction');
    const undoFootprint=undoSubmitted.reduce((n,e)=>n+(e.end-e.start)+e.textLength,0);
    const wholeDocumentRoundTrip=fullDocumentFootprint+reviewedText.length+largeOriginal.length;
    const hunkRoundTrip=footprint+undoFootprint;
    const roundTripImprovement=1-hunkRoundTrip/wholeDocumentRoundTrip;
    console.log(`Review edit footprint: whole-document baseline=${wholeDocumentRoundTrip} chars; current=${hunkRoundTrip}; reduction=${(roundTripImprovement*100).toFixed(2)}%`);
    assert.ok(roundTripImprovement>=0.5,'apply plus undo edit footprint is at least 50% below the whole-document baseline');
    assert.equal(largeDoc.getText(),largeOriginal,'undo restores the exact large-file original');
  }
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
  const created=await edits.applyText(request(fresh,{path:fresh.path,text:'new',textSha256:hash('new')}));
  assert.equal(created.status,'saved');
  assert.equal(await fs.readFile(path.join(dir,'new.py'),'utf8'),'new');
  await edits.undo(created.undo.undoId);
  await assert.rejects(fs.access(path.join(dir,'new.py')),'undo removes a created file');
  const clash=make({proposalId:'clash',callId:'clash',path:path.basename(dir)+'/clash.py',isNewFile:true,baseSha256:null,originalText:'',proposedText:'mine',
    hunks:[{hunkId:'a',startOffset:0,endOffset:0,oldText:'',newText:'mine'}]});
  edits.begin(clash); edits.decide(clash,{a:'accept'});
  await fs.writeFile(path.join(dir,'clash.py'),'theirs');
  await check('stale',request(clash,{path:clash.path,text:'mine',textSha256:hash('mine')}));
  assert.equal(await fs.readFile(path.join(dir,'clash.py'),'utf8'),'theirs','a file that appeared after review is never overwritten');
  // failed_before_apply: a second approved apply to the same document while the first is in progress.
  const busyFile=path.join(dir,'busy.py'), busyLocal=path.basename(dir)+'/busy.py';
  await fs.writeFile(busyFile,original);
  const busyProposal=(id,newText)=>make({proposalId:id,callId:id,path:busyLocal,proposedText:newText+'\ntwo\n',
    hunks:[{hunkId:'a',startOffset:0,endOffset:3,oldText:'one',newText}]});
  const b1=busyProposal('b1','ONE'), b2=busyProposal('b2','UNO');
  edits.begin(b1); edits.decide(b1,{a:'accept'}); edits.decide(b2,{a:'accept'});
  const [first,second]=await Promise.all([
    edits.applyText(request(b1,{path:busyLocal,text:'ONE\ntwo\n',textSha256:hash('ONE\ntwo\n')})),
    edits.applyText(request(b2,{path:busyLocal,text:'UNO\ntwo\n',textSha256:hash('UNO\ntwo\n')}))]);
  assert.equal(first.status,'saved');
  assert.equal(second.status,'failed_before_apply');
  assert.equal(await fs.readFile(busyFile,'utf8'),'ONE\ntwo\n','only the first apply changed the file');
  edits.end();

  // A save participant that strips trailing whitespace (stands in for format-on-save).
  const fmtDir=path.basename(dir);
  const formatter=vscode.workspace.onWillSaveTextDocument(e=>{
    if (!e.document.uri.fsPath.startsWith(dir+path.sep+'fmt')) return;
    const text=e.document.getText(), trimmed=text.replace(/[ \t]+$/gm,'');
    if (trimmed!==text) e.waitUntil(Promise.resolve([vscode.TextEdit.replace(
      new vscode.Range(e.document.positionAt(0),e.document.positionAt(text.length)),trimmed)]));
  });
  try {
    // 1. The formatter changes the applied text: the receipt holds the post-save hash and undo still works.
    const f1=path.join(dir,'fmt1.py'), f1Local=fmtDir+'/fmt1.py', f1Orig='a = 1\n', f1New='a = 2   \n';
    await fs.writeFile(f1,f1Orig);
    const p1=make({proposalId:'f1',callId:'f1',path:f1Local,baseSha256:hash(f1Orig),originalText:f1Orig,proposedText:f1New,
      hunks:[{hunkId:'a',startOffset:0,endOffset:5,oldText:'a = 1',newText:'a = 2   '}]});
    edits.begin(p1); edits.decide(p1,{a:'accept'});
    const r1=await edits.applyText(request(p1,{path:f1Local,expectedSha256:hash(f1Orig),text:f1New,textSha256:hash(f1New)}));
    assert.equal(r1.status,'saved');
    assert.equal(await fs.readFile(f1,'utf8'),'a = 2\n','the save participant ran');
    assert.equal(r1.savedTextSha256,hash('a = 2\n'));
    assert.equal(r1.undo.expectedPostSha256,hash('a = 2\n'),'the receipt carries the post-save hash');
    await edits.undo(r1.undo.undoId);
    assert.equal(await fs.readFile(f1,'utf8'),f1Orig);
    edits.end();
    // 2. The formatter would also change the original: undo restores the exact original bytes anyway.
    const f2=path.join(dir,'fmt2.py'), f2Local=fmtDir+'/fmt2.py', f2Orig='b = 1   \n', f2New='b = 2\n';
    await fs.writeFile(f2,f2Orig);
    const p2=make({proposalId:'f2',callId:'f2',path:f2Local,baseSha256:hash(f2Orig),originalText:f2Orig,proposedText:f2New,
      hunks:[{hunkId:'a',startOffset:0,endOffset:8,oldText:'b = 1   ',newText:'b = 2'}]});
    edits.begin(p2); edits.decide(p2,{a:'accept'});
    const r2=await edits.applyText(request(p2,{path:f2Local,expectedSha256:hash(f2Orig),text:f2New,textSha256:hash(f2New)}));
    assert.equal(r2.status,'saved');
    await edits.undo(r2.undo.undoId);
    assert.equal(await fs.readFile(f2,'utf8'),f2Orig,'undo saved without save participants');
    edits.end();
    // 3. A new file: expectedPostSha256 matches what is on disk.
    const n3=make({proposalId:'n3',callId:'n3',path:fmtDir+'/fmt3.py',isNewFile:true,baseSha256:null,originalText:'',proposedText:'c = 3\n',
      hunks:[{hunkId:'a',startOffset:0,endOffset:0,oldText:'',newText:'c = 3\n'}]});
    edits.begin(n3); edits.decide(n3,{a:'accept'});
    const r3=await edits.applyText(request(n3,{path:n3.path,expectedSha256:null,text:'c = 3\n',textSha256:hash('c = 3\n')}));
    assert.equal(r3.status,'saved');
    assert.equal(r3.undo.expectedPostSha256,hash(await fs.readFile(path.join(dir,'fmt3.py'),'utf8')));
    await edits.undo(r3.undo.undoId);
    await assert.rejects(fs.access(path.join(dir,'fmt3.py')));
  } finally { formatter.dispose(); }
  // Stop after the WorkspaceEdit was submitted: the edit lands and is saved, reported as 'saved' (not deferred).
  {
    const s1=path.join(dir,'stop1.py'), s1Local=path.basename(dir)+'/stop1.py';
    await fs.writeFile(s1,original);
    const ps=make({proposalId:'s1',callId:'s1',path:s1Local});
    edits.begin(ps); edits.decide(ps,{a:'accept',b:'reject'});
    let stoppedMidApply=false;
    const stopper=vscode.workspace.onDidChangeTextDocument(e=>{
      if (e.document.uri.fsPath===s1 && e.contentChanges.length && !stoppedMidApply) { stoppedMidApply=true; edits.end(); }
    });
    try {
      const rs=await edits.applyText(request(ps,{path:s1Local}));
      assert.ok(stoppedMidApply,'Stop (end of review) arrived while the edit was being applied');
      assert.equal(rs.status,'saved','an edit already submitted to VS Code is finished and saved after Stop');
      assert.equal(await fs.readFile(s1,'utf8'),replacement);
      assert.equal((await vscode.workspace.openTextDocument(vscode.Uri.file(s1))).isDirty,false,'nothing left unsaved in the buffer');
      await check('approval_missing',request(ps,{path:s1Local,proposalId:'s2',callId:'s2'}));
      await edits.undo(rs.undo.undoId);
      assert.equal(await fs.readFile(s1,'utf8'),original);
    } finally { stopper.dispose(); }
  }
  edits.dispose(); failing.dispose();
  console.log('PASS simulated turn, all six apply outcomes (incl. failed_before_apply), partial approval, cancel gate, guarded undo, undo with a formatting save participant, replay after save failure, safe new-file creation, Stop mid-apply saves the submitted edit');
};
