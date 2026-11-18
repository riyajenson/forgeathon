// Opt-in integration rehearsal: real VS Code, real TrueForge, local scripted model.
// The runner starts its own loopback TrueForge instance with a fresh SQLite file.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const vscode = require('vscode');
const { renderer, until } = require('./driver.cjs');

async function freePort() {
  const s = net.createServer();
  s.listen(0,'127.0.0.1'); await once(s,'listening');
  const port = s.address().port; await new Promise(resolve=>s.close(resolve)); return port;
}
exports.run = async() => {
  assert.ok(process.env.FORGE_TEST_CDP_PROFILE && process.env.FORGE_TEST_TRUEFORGE_CLI && process.env.FORGE_TEST_NODE,
    'This rehearsal requires an isolated profile, local Node and TrueForge 0.185.1 CLI.');
  const folder = vscode.workspace.workspaceFolders[0];
  const root = folder.uri.fsPath;
  assert.equal((await fs.readdir(root)).length,0,'Use an empty temporary workspace');
  const data = await fs.mkdtemp(path.join(path.dirname(root),'trueforge-'));
  const tfPort = await freePort(), mcpPort = await freePort(), url = 'http://127.0.0.1:'+tfPort;
  const server = spawn(process.env.FORGE_TEST_NODE,[process.env.FORGE_TEST_TRUEFORGE_CLI,'--port',String(tfPort)],{
    cwd:data, stdio:'ignore',env:{PATH: process.env.PATH,HOST:'127.0.0.1',SQLITE_PATH:path.join(data,'test.sqlite'),
      OUTBOUND_URL_ALLOWED_HOSTS:'["127.0.0.1"]',MODEL_HTTP_CONNECT_TIMEOUT_MS:'3000',MODEL_HTTP_MAX_RETRIES:'1'}
  });
  const closed = once(server,'exit');
  const entry = path.dirname(require.resolve('forge-harness'));
  const { MockModel, MOCK_KEY, textOf } = require(path.join(entry,'testing/mock-model'));
  const { runSetup } = require(path.join(entry,'setup/setup'));
  const { createClient } = require(path.join(entry,'trueforge/sdk'));
  const { repoRoot } = require(path.join(entry,'repo-root'));
  const model = new MockModel();
  let driver;
  try {
    await until(async()=>{try {return (await fetch(url)).ok} catch{return false}},'isolated TrueForge startup',30000);
    await model.start(0);
    const {client} = await createClient(url);
    const agentsDir = path.join(repoRoot(),'agent');
    const templates = await Promise.all((await fs.readdir(agentsDir)).filter(n=>n.endsWith('.json')).map(async n=>
      JSON.parse(await fs.readFile(path.join(agentsDir,n),'utf8'))));
    const cfg={providers:['editor-test-provider','editor-test-fallback'].map(name=>({type:'custom',name,baseUrl:'http://127.0.0.1:'+model.port+'/v1',
      apiKeyEnv:'TEST_KEY',models:[{name:'scripted',modelId:'scripted',contextLength:32000,maxOutputTokens:1024}]})),
      agents:{primaryModel:'editor-test-provider/scripted',fallbackModel:'editor-test-fallback/scripted'}};
    await runSetup({client,cfg,templates,env:{TEST_KEY:MOCK_KEY},log:()=>{}});
    await vscode.workspace.getConfiguration('forge').update('trueforgeUrl',url,vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration('forge').update('mcpPort',mcpPort,vscode.ConfigurationTarget.Global);
    const file=path.join(root,'sample.py'), before='first = 1\nsecond = 2\n', after='first = 3\nsecond = 2\n';
    await fs.writeFile(file,before);
    const doc=await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    const editor=await vscode.window.showTextDocument(doc);
    editor.selection=new vscode.Selection(doc.positionAt(0),doc.positionAt(before.length));
    model.handler=req=>{
      const last=req.messages.at(-1);
      if(last?.role==='tool') return {text:'The reviewed edit was processed.'};
      const user=req.messages.filter(m=>m.role==='user').map(m=>textOf(m.content)).join('\n');
      const base=/file sha256: ([0-9a-f]{64})/.exec(user)?.[1];
      return {toolCalls:[{name:'propose_edit',args:{path:'sample.py',base_sha256:base,summary:'Two sample edits',
        edits:[{old_text:'first = 1',new_text:'first = 3'},{old_text:'second = 2',new_text:'second = 4'}]}}]};
    };
    driver=await renderer();
    const run=vscode.commands.executeCommand('forgeathon.inlineEdit');
    await until(()=>driver.evaluate("document.activeElement?.closest('.quick-input-widget') !== null && document.activeElement?.tagName === 'INPUT'"),'inline instruction input');
    await driver.send('Input.insertText',{text:'Update both sample assignments'});
    await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
    await until(()=>vscode.window.tabGroups.all.flatMap(g=>g.tabs).some(tab=>
      tab.input instanceof vscode.TabInputTextDiff && tab.input.original.scheme==='forge-preview'),'native diff',45000);
    assert.equal(await fs.readFile(file,'utf8'),before,'Preview changed disk');
    await until(()=>driver.evaluate("document.body.innerText.includes('Review hunks')"),'review control');
    await vscode.commands.executeCommand('forgeathon.reviewHunks');
    await until(()=>driver.evaluate("document.querySelector('.quick-input-widget')?.innerText.includes('Hunk 1')"),'hunk picker');
    const row = ".quick-input-widget .quick-input-list .monaco-list-row";
    const box = row + ' .monaco-checkbox';
    assert.ok(await driver.evaluate(`(() => {const el=document.querySelector(${JSON.stringify(box)});if(!el)return false;el.click();return true;})()`),
      'First hunk checkbox must be checked before submitting');
    await until(()=>driver.evaluate("document.querySelectorAll('.quick-input-list .monaco-checkbox[aria-checked=true]').length === 1"),'one selected hunk');
    await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
    await Promise.race([run,new Promise((_,reject)=>setTimeout(()=>reject(Error('Turn did not finish')),30000))]);
    assert.equal(await fs.readFile(file,'utf8'),after,'Only the first hunk should be saved');
    assert.ok(model.requests.some(r=>r.messages.some(m=>m.role==='tool')),'Tool result returned to model');
    const sessions=await client.sessions.list();
    assert.ok(sessions.data.length,'TrueForge session persisted');
    await vscode.commands.executeCommand('forgeathon.undo');
    assert.equal(await fs.readFile(file,'utf8'),before,'Undo did not restore original');
    console.log('PASS real TrueForge 0.185.1 + scripted model, inline command, native diff, per-hunk review, saved MCP edit, undo; session '+sessions.data[0].id);
    console.log('Extension host '+process.platform+' Node '+process.versions.node+' remoteName='+(vscode.env.remoteName||'local'));
  } finally {
    driver?.close(); await model.stop(); server.kill('SIGTERM');
    await Promise.race([closed,new Promise(resolve=>setTimeout(resolve,2500))]);
    if (server.exitCode===null && server.signalCode===null) server.kill('SIGKILL');
  }
};
