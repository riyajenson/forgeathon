const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(probe, description, timeout = 12000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await probe();
    if (value) return value;
    await sleep(50);
  }
  throw Error('Timed out: ' + description);
}
// Isolated test profile only. Chromium assigns a random localhost port.
async function renderer() {
  const profile = process.env.FORGE_TEST_CDP_PROFILE;
  assert.ok(profile, 'Set FORGE_TEST_CDP_PROFILE to the isolated test profile');
  const port = (await fs.readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split(/\s/)[0];
  const pages = await (await fetch('http://127.0.0.1:'+port+'/json/list')).json();
  const target = pages.find(page => page.type === 'page' && page.url.includes('workbench'));
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve,reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0; const pending = new Map();
  ws.onmessage = event => {
    const m = JSON.parse(event.data);
    if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = async (method, params) => {
    const n = ++id;
    const reply = new Promise(resolve=>pending.set(n,resolve));
    ws.send(JSON.stringify({id:n,method,params}));
    const result = await reply;
    if (result.error) throw Error(result.error.message);
    return result.result;
  };
  return { send, close:()=>ws.close(), evaluate:async expression=>
    (await send('Runtime.evaluate',{expression,returnByValue:true})).result.value };
}
module.exports={until,renderer};
