// Drives the real VS Code window (Extension Development Host, started by launch-vscode.sh) through the demo at
// human pace: real keyboard input and real pointer moves and clicks, so the recording shows what a user would do.
// Every step appends timestamped markers (JSON lines) that the video edit uses to find the cuts.
//
// usage: node drive.cjs <step> <markers.jsonl>
//   steps: layout | A | cancel | B | Bresume | Bverify | C | newconv | state
//   Bresume: continue answering an interrupted Task B turn (REVIEWS_SO_FAR=<n> keeps the review count).
// env: FORGE_DEMO_CDP_PORT (default 9333), FORGE_DEMO_WORKSPACE (default ~/flask-demo)
const { chromium } = require('playwright-core');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const step = process.argv[2], markers = process.argv[3];
const CDP = 'http://127.0.0.1:' + (process.env.FORGE_DEMO_CDP_PORT || '9333');
const WORKSPACE = process.env.FORGE_DEMO_WORKSPACE || path.join(os.homedir(), 'flask-demo');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const now = () => Date.now() / 1000;
const mark = (ev, extra = {}) => {
  fs.appendFileSync(markers, JSON.stringify({ t: now(), step, ev, ...extra }) + '\n');
  console.log(new Date().toISOString().slice(11, 19), ev, JSON.stringify(extra));
};
const INSTR_A = "Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.";
const INSTR_B = 'Add a new built-in CLI command flask config that prints the loaded application\'s configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.';
/** The hunk picker's title; it opens with the diff for every review. */
const PICKER = /Select hunks to accept/;
let page;

async function until(fn, what, timeout = 30000, every = 200) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch { } await sleep(every); }
  throw Error('Timed out: ' + what);
}
async function typeHuman(text, delay = 28) { await page.keyboard.type(text, { delay }); }
async function palette(cmd) {
  await page.keyboard.press('F1'); await sleep(700);
  await typeHuman(cmd, 22); await sleep(900);
  await page.keyboard.press('Enter'); await sleep(800);
}

// The agent panel is a webview (out-of-process iframe): read it through its own DevTools target,
// act on it with real mouse/keyboard events on the main window.
let wvWs, wvId = 0; const wvPending = new Map();
async function wvConnect() {
  const list = await (await fetch(CDP + '/json/list')).json();
  const t = list.find(x => x.type === 'iframe' && x.url.startsWith('vscode-webview://') && x.url.includes('index.html'));
  if (!t) throw Error('no webview target');
  wvWs = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { wvWs.onopen = res; wvWs.onerror = rej; });
  wvWs.onmessage = e => { const m = JSON.parse(e.data); if (wvPending.has(m.id)) { wvPending.get(m.id)(m); wvPending.delete(m.id); } };
  wvWs.onclose = () => { wvWs = undefined; };
}
async function wv(expr) {
  if (!wvWs) await wvConnect();
  const n = ++wvId; const p = new Promise(r => wvPending.set(n, r));
  wvWs.send(JSON.stringify({ id: n, method: 'Runtime.evaluate', params: { expression: '(()=>{const d=document.querySelector("iframe").contentDocument; const el=id=>d.getElementById(id); return (' + expr + ')})()', returnByValue: true } }));
  const m = await p; if (m.error || m.result.exceptionDetails) throw Error('wv eval: ' + JSON.stringify(m.error || m.result.exceptionDetails).slice(0, 200));
  return m.result.result.value;
}
async function wvPoint(id) {
  const inner = await wv('(()=>{const fb=document.querySelector("iframe").getBoundingClientRect(); const r=el(' + JSON.stringify(id) + ').getBoundingClientRect(); return [fb.x+r.x+r.width/2, fb.y+r.y+r.height/2]})()');
  const outer = await page.evaluate(() => { const f = [...document.querySelectorAll('iframe.webview')].find(f => f.offsetParent); const b = f.getBoundingClientRect(); return [b.x, b.y]; });
  return [outer[0] + inner[0], outer[1] + inner[1]];
}
async function wvClick(id, hold = 1000) { const [x, y] = await wvPoint(id); await page.mouse.move(x, y, { steps: 8 }); await sleep(hold); await page.mouse.click(x, y); }
const wvHidden = id => wv('el(' + JSON.stringify(id) + ').hidden');
const wvText = id => wv('el(' + JSON.stringify(id) + ').textContent');
const wvDisabled = id => wv('el(' + JSON.stringify(id) + ').disabled');
const wvScroll = (id, block = 'start') => wv('el(' + JSON.stringify(id) + ').scrollIntoView({behavior:"smooth",block:"' + block + '"})');

/** Text of the quick input (hunk picker, command approval, inline instruction) while it is really on screen. */
const qiText = () => page.evaluate(() => {
  const w = document.querySelector('.quick-input-widget');
  if (!w || w.style.display === 'none' || !w.offsetParent) return '';
  const r = w.getBoundingClientRect();
  return r.height > 10 && getComputedStyle(w).visibility !== 'hidden' ? w.innerText : '';
});
/**
 * Picks a quick-pick row by label. A row can be in the list but not rendered as visible (the command approval's
 * "Allow once" row sometimes is, under the prompt's long detail text): then hovering or clicking it would time out,
 * so select it with the keyboard instead, as a user would.
 */
async function pickRow(label, hold = 1200) {
  const row = page.locator('.quick-input-widget .monaco-list-row', { hasText: label }).first();
  if (await row.isVisible()) { await row.hover(); await sleep(hold); await row.click(); mark('picked', { label }); return; }
  await sleep(hold);
  const items = await page.locator('.quick-input-widget .monaco-list-row').allInnerTexts();
  const i = items.findIndex(x => x.includes(label));
  if (i < 0) throw Error('no row ' + label);
  await page.keyboard.press('Home'); for (let k = 0; k < i; k++) await page.keyboard.press('ArrowDown');
  await sleep(300); await page.keyboard.press('Enter'); mark('picked_kbd', { label, i });
}
/**
 * Clicks a hunk-picker title button (codicon 'check' = Accept all hunks, 'close' = Reject all hunks). The pointer
 * moves onto the button and rests there so the tooltip shows on the video; the click then goes to the button's
 * coordinates. (A locator click waits for the element to receive pointer events, which the tooltip it just opened
 * over the button can intercept.)
 */
async function qiButton(icon, hold = 1200) {
  const btn = page.locator('.quick-input-widget .quick-input-titlebar .codicon-' + icon + ', .quick-input-widget .quick-input-header .codicon-' + icon).first();
  if (await btn.count()) {
    const bb = await btn.boundingBox();
    if (bb) {
      const x = bb.x + bb.width / 2, y = bb.y + bb.height / 2;
      await page.mouse.move(x, y, { steps: 8 }); await sleep(hold); await page.mouse.click(x, y);
      mark('qibutton', { icon }); return;
    }
  }
  mark('qibutton_missing', { icon });
  if (icon === 'check') { await page.keyboard.press('Enter'); return; } // Enter submits with every hunk checked
  throw Error('no ' + icon + ' button');
}
async function focusTerminal() {
  await page.locator('.terminal-wrapper .xterm-screen').first().click(); await sleep(600);
}
async function term(cmd, hold = 4000) {
  await focusTerminal();
  await typeHuman(cmd, 30); await sleep(500);
  mark('term', { cmd }); await page.keyboard.press('Enter');
  await sleep(hold);
}
async function focusEditorFile(rel) {
  await page.keyboard.press('Control+1'); await sleep(400);
  await page.keyboard.press('Control+p'); await sleep(700);
  await typeHuman(rel, 25); await sleep(900); await page.keyboard.press('Enter'); await sleep(1000);
}
/** get_debug_flag in Flask 3.1.3's src/flask/helpers.py: lines 28-33. */
async function selectGetDebugFlag() {
  await page.keyboard.press('Control+g'); await sleep(600);
  await typeHuman('28', 80); await sleep(400); await page.keyboard.press('Enter'); await sleep(600);
  await page.keyboard.press('Home'); await sleep(300);
  for (let i = 0; i < 6; i++) { await page.keyboard.press('Shift+ArrowDown'); await sleep(150); }
  mark('selected'); await sleep(1500);
}
const diffShown = async () => PICKER.test(await qiText());
async function inlineEdit() {
  await page.keyboard.press('Control+Alt+i'); await sleep(900);
  const t = await qiText();
  if (!t || /copilot|chat/i.test(t) && !/instruction|edit/i.test(t)) {
    mark('ctrlAltI-fallback', { t }); await page.keyboard.press('Escape'); await sleep(300);
    await palette('Forge-a-thon: Inline Edit'); await sleep(600);
  }
  await typeHuman(INSTR_A, 22); await sleep(800);
  mark('instruction_sent', { task: 'A' }); await page.keyboard.press('Enter');
}
async function inlineDone(timeout = 120000) {
  // The inline turn ends when its progress notification closes.
  await sleep(500);
  await until(async () => !(await page.evaluate(() => [...document.querySelectorAll('.notification-toast, .notifications-center')].some(e => e.offsetParent && /Forge inline edit/.test(e.innerText)))), 'inline turn end', timeout);
}
const gitStatus = () => execFileSync('git', ['-C', WORKSPACE, 'status', '--short']).toString();

/** Answers every review (✓ Accept all hunks) and command prompt (Allow once; Deny when unrestricted) of an agent turn. */
async function answer(t, reviews) {
  if (PICKER.test(t)) {
    reviews.n++; mark(reviews.n === 1 ? 'first_diff' : 'diff', { task: 'B', n: reviews.n, title: t.split('\n')[0] });
    await sleep(2000); await qiButton('check', 1400);
    await until(async () => !PICKER.test(await qiText()), 'review closed', 10000);
    mark('accepted', { n: reviews.n });
    return true;
  }
  if (/Allow this command/.test(t)) {
    const unrestricted = /Unrestricted/.test(t);
    mark('cmd_prompt', { unrestricted, t: t.slice(0, 200) }); await sleep(2000);
    await pickRow(unrestricted ? 'Deny' : 'Allow once', 1200);
    return true;
  }
  return false;
}
async function filesChanged(reviews) {
  mark('B_turn_done', { status: await wvText('status'), git: gitStatus(), reviews: reviews.n });
  if (!(await wvHidden('turnFiles'))) await wvScroll('turnFiles');
  mark('files_changed', { title: await wvText('turnFilesTitle') }); await sleep(3000);
}

const steps = {
  async layout() {
    await page.keyboard.press('Escape');
    await palette('View: Close All Editors'); await sleep(500);
    await focusEditorFile('src/flask/helpers.py');
    await palette('Forge-a-thon: Open Agent Panel'); await sleep(1500);
    await palette('View: Move Editor into Right Group'); await sleep(1000);
    await page.keyboard.press('Control+1'); await sleep(300);
    if (await page.evaluate(() => !!document.querySelector('.part.sidebar')?.offsetParent)) { await page.keyboard.press('Control+b'); await sleep(400); }
    if (!(await page.evaluate(() => !!document.querySelector('.terminal-wrapper')?.offsetParent))) { await page.keyboard.press('Control+`'); await sleep(1500); }
    await focusTerminal();
    await page.keyboard.type(`cd ${WORKSPACE} && source .venv/bin/activate && clear\n`); await sleep(1500);
    await page.keyboard.press('Control+1');
  },
  async A() {
    mark('seg_start', { seg: 'A' });
    await focusEditorFile('src/flask/helpers.py');
    await selectGetDebugFlag();
    mark('A1_start');
    await inlineEdit();
    await until(diffShown, 'Task A diff', 240000, 100);
    mark('first_diff', { task: 'A', after: 0 }); await sleep(2500);
    // Show the per-hunk choice: uncheck the last hunk, then check it again, then submit every hunk.
    mark('hunk_picker');
    const rows = page.locator('.quick-input-widget .monaco-list-row');
    const nrows = await rows.count(); mark('hunk_rows', { nrows });
    if (nrows >= 2) {
      const cb = rows.nth(nrows - 1).locator('.quick-input-list-checkbox, input[type=checkbox], .monaco-checkbox').first();
      try { await cb.hover(); await sleep(1200); await cb.click(); mark('unchecked'); await sleep(1800); await cb.click(); mark('rechecked'); await sleep(1500); }
      catch (e) { mark('cb_fail', { m: e.message }); }
    }
    await sleep(1500);
    mark('accept_hunks'); await page.keyboard.press('Enter');
    await inlineDone(); mark('A_turn_done', { status: gitStatus() });
    await sleep(1500);
    mark('verify_A');
    await term('FLASK_DEBUG=off python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"', 4000);
    mark('undo_start');
    await page.keyboard.press('Control+1'); await sleep(400);
    await palette('Forge-a-thon: Undo Last Reviewed Edit'); await sleep(2500);
    mark('undo_done', { status: gitStatus() });
    await term('git status --short', 3000);
    mark('seg_end', { seg: 'A' });
  },
  async cancel() {
    mark('seg_start', { seg: 'cancel' });
    await wv('el("task").value=""');
    await wvClick('task', 600);
    await typeHuman('Add type hints to every function in src/flask/cli.py', 30);
    await sleep(800); await wvClick('send', 800); mark('cancel_send');
    await until(async () => (await wvText('text')).trim().length > 0 || !(await wvHidden('activity')), 'stream start', 120000, 100);
    mark('streaming'); await sleep(3000);
    await wvClick('stop', 700); mark('stop_click');
    await until(async () => /cancel/i.test(await wvText('status')), 'cancelled status', 30000);
    mark('cancelled', { status: await wvText('status') }); await sleep(2500);
    await term('git status --short', 3000);
    mark('seg_end', { seg: 'cancel', git: gitStatus() });
  },
  async B() {
    mark('seg_start', { seg: 'B' });
    await wv('el("task").value=""'); await wv('d.scrollingElement.scrollTop=0');
    await wvClick('task', 600);
    await typeHuman(INSTR_B, 14); await sleep(1200);
    await wvClick('send', 800); mark('instruction_sent', { task: 'B' });
    let shownContext = false; const reviews = { n: 0 };
    const t0 = now();
    while (true) {
      if (now() - t0 > 900) throw Error('B took too long');
      if (!shownContext && !(await wvHidden('context'))) {
        await wvScroll('context');
        mark('context_shown'); await sleep(4000); shownContext = true;
        await wvScroll('activity');
      }
      if (await answer(await qiText(), reviews)) continue;
      if (!(await wvDisabled('send')) && now() - t0 > 5) break;
      await sleep(150);
    }
    await filesChanged(reviews);
    await steps.Bverify();
  },
  async Bresume() {
    const reviews = { n: Number(process.env.REVIEWS_SO_FAR || 0) }; const t0 = now(); let quiet = 0;
    // A review can hide the panel's tab behind the diff editor; bring it back between prompts.
    const showPanel = async () => {
      try {
        if (await qiText()) return;
        const tab = page.locator('.tab', { hasText: 'Forge Agent' }).first();
        if (await tab.count()) {
          await tab.hover({ timeout: 2000 }); await sleep(700); if (await qiText()) return;
          await tab.click({ timeout: 2000 }); mark('panel_tab'); await sleep(800);
        }
      } catch { mark('panel_tab_skip'); }
    };
    while (true) {
      if (now() - t0 > 900) throw Error('B took too long');
      const t = await qiText();
      if (await answer(t, reviews)) { await sleep(500); await showPanel(); wvWs = undefined; continue; }
      let busy = null; try { busy = await wvDisabled('send'); } catch { wvWs = undefined; }
      if (busy === false) { if (++quiet > 3) break; } else quiet = 0;
      if (busy === null && !t) { await showPanel(); await sleep(1500); }
      await sleep(250);
    }
    await filesChanged(reviews);
  },
  async Bverify() {
    mark('verify_B');
    await palette('View: Toggle Maximized Panel'); await sleep(800);
    await term('clear && pytest tests/test_cli.py -q', 8000);
    await term('clear && cd examples/tutorial && flask --app flaskr --help', 5000);
    await term('clear && flask --app flaskr config', 6000);
    await term(`cd ${WORKSPACE} && clear`, 500);
    await palette('View: Toggle Maximized Panel'); await sleep(800);
    mark('trace_click_start');
    await wvScroll('trace', 'center'); await sleep(800);
    await wvClick('trace', 1200); mark('trace_clicked'); await sleep(1500);
    mark('seg_end', { seg: 'B' });
  },
  async C() {
    mark('seg_start', { seg: 'C' });
    await term('clear && git status --short', 3000);
    await focusEditorFile('src/flask/helpers.py');
    await selectGetDebugFlag();
    await inlineEdit();
    // The fallback banner (warning notification) appears before the fallback model's diff.
    await until(diffShown, 'Task C diff', 240000, 100);
    mark('first_diff', { task: 'C' });
    const banner = await page.evaluate(() => [...document.querySelectorAll('.notification-toast')].map(e => e.innerText).join(' | '));
    mark('banner', { banner }); await sleep(4000);
    await term('git status --short', 3000);
    await qiButton('close', 1500);
    await inlineDone(); mark('rejected');
    await term('git status --short', 3500);
    mark('seg_end', { seg: 'C', git: gitStatus() });
  },
  async newconv() { await palette('Forge-a-thon: New Agent Conversation'); await sleep(800); await wv('d.scrollingElement.scrollTop=0'); await page.keyboard.press('Control+1'); },
  /** Debug helper: what the quick input and the panel show right now. */
  async state() {
    console.log(JSON.stringify(await qiText()).slice(0, 200));
    try { console.log(await wvText('status'), await wvDisabled('send'), await wvText('turnFilesTitle')); } catch (e) { console.log('wv', e.message); }
  },
};

(async () => {
  if (!steps[step] || !markers) { console.error('usage: node drive.cjs <' + Object.keys(steps).join('|') + '> <markers.jsonl>'); process.exit(64); }
  const b = await chromium.connectOverCDP(CDP);
  page = b.contexts().flatMap(c => c.pages()).find(p => p.url().includes('workbench'));
  try { await steps[step](); console.log('STEP OK', step); }
  catch (e) { mark('error', { msg: e.message }); console.error('STEP FAILED', step, e.message); await page.screenshot({ path: markers + '.' + step + '.fail.png' }).catch(() => { }); process.exitCode = 1; }
  process.exit();
})();
