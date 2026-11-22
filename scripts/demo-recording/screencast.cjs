// Continuous DevTools screencast of the VS Code workbench started by launch-vscode.sh: frames/<n>.jpg plus
// index.tsv (frame timestamp in epoch seconds, file name), to be cut against drive.cjs's markers.
// usage: node screencast.cjs <outDir>   (stop with SIGTERM)   env: FORGE_DEMO_CDP_PORT (default 9333)
const { chromium } = require('playwright-core');
const fs = require('node:fs');
const path = require('node:path');

const out = process.argv[2];
if (!out) { console.error('usage: node screencast.cjs <outDir>'); process.exit(64); }
const port = process.env.FORGE_DEMO_CDP_PORT || '9333';
fs.mkdirSync(path.join(out, 'frames'), { recursive: true });
const idx = fs.openSync(path.join(out, 'index.tsv'), 'a');
(async () => {
  const b = await chromium.connectOverCDP('http://127.0.0.1:' + port);
  const page = b.contexts().flatMap(c => c.pages()).find(p => p.url().includes('workbench'));
  const s = await page.context().newCDPSession(page);
  let n = 0;
  s.on('Page.screencastFrame', async f => {
    n++; const name = String(n).padStart(7, '0') + '.jpg';
    fs.writeFileSync(path.join(out, 'frames', name), Buffer.from(f.data, 'base64'));
    fs.writeSync(idx, f.metadata.timestamp.toFixed(3) + '\t' + name + '\n');
    try { await s.send('Page.screencastFrameAck', { sessionId: f.sessionId }); } catch { }
  });
  await s.send('Page.startScreencast', { format: 'jpeg', quality: 90, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
  console.log('recording', out);
  process.on('SIGTERM', async () => { try { await s.send('Page.stopScreencast'); } catch { } process.exit(0); });
  setInterval(() => { }, 1e9);
})();
