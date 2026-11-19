// Live end-to-end test in a real VS Code window: the extension's Workbench drives Tasks A, B, Stop and C
// through forge-harness and a running TrueForge with the scripted demo model, on a copy of Flask 3.1.3.
// Run with scripts/test-extension-e2e.sh (it starts the demo mode and prepares the workspace).
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const vscode = require('vscode');
const { Workbench } = require('../out/workbench');
const { configuredHarness } = require('../out/connect');

const run = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { until } = require('./driver.cjs');
const TASK_A = "Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.";
const TASK_B = 'Add a new built-in CLI command flask config that prints the loaded application\'s configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.';

async function git(root, ...args) { return (await run('git', args, { cwd: root })).stdout.trim(); }

// Answers reviews and command prompts the way a user would, until `done` resolves.
async function withAnswers(ui, choice, work, { stopAtFirstReview = false } = {}) {
  let finished = false;
  const seen = { reviews: 0, commands: 0 };
  const answering = (async () => {
    while (!finished) {
      const state = ui.panel.state;
      if (state.reviewing) {
        seen.reviews++;
        if (stopAtFirstReview) { await ui.stop(); return; }
        ui.decideAll(choice);
        await sleep(150);
      } else if (state.command && ui.commandAnswer) {
        seen.commands++;
        ui.commandAnswer(true);
      }
      await sleep(80);
    }
  })();
  try { await work(); } finally { finished = true; await answering; }
  return seen;
}

exports.run = async () => {
  const folder = vscode.workspace.workspaceFolders[0];
  const root = folder.uri.fsPath;
  assert.equal(await git(root, 'rev-parse', 'HEAD'), '22d924701a6ae2e4cd01e9a15bbaf3946094af65', 'workspace is Flask 3.1.3');
  assert.equal(await git(root, 'status', '--porcelain'), '', 'workspace starts clean');
  const ui = new Workbench(folder, configuredHarness);
  const helpers = vscode.Uri.joinPath(folder.uri, 'src/flask/helpers.py');
  try {
    // ---------------- Task A: inline edit, accept, verify on disk, undo
    const doc = await vscode.workspace.openTextDocument(helpers);
    const editor = await vscode.window.showTextDocument(doc);
    const start = doc.getText().split('\n').findIndex((l) => l.startsWith('def get_debug_flag('));
    editor.selection = new vscode.Selection(start, 0, start + 6, 0);
    const selection = { path: 'src/flask/helpers.py', text: doc.getText(editor.selection), startLine: start + 1, endLine: start + 6 };
    const a = await withAnswers(ui, 'accept', () => ui.run('inline', TASK_A, { activeFile: 'src/flask/helpers.py', selection }));
    assert.equal(a.reviews >= 1, true, 'Task A showed a review');
    const afterA = await fs.readFile(helpers.fsPath, 'utf8');
    assert.match(afterA, /\{"0", "false", "no", "off", "n"\}/, 'Task A edit saved to disk');
    assert.ok(ui.panel.state.trace.includes('sessionId='), 'TrueForge session link available');
    assert.ok(ui.panel.state.context && ui.panel.state.context.selections.some((s) => s.source === 'selection'), 'context report with the pinned selection');
    await ui.undo();
    assert.equal(await git(root, 'status', '--porcelain'), '', 'undo restores helpers.py');
    console.log('PASS Task A: inline review, accept, saved, session link, context report, undo');

    // ---------------- Task B: agent panel, per-file reviews, command approval, three files
    const b = await withAnswers(ui, 'accept', () => ui.run('agent', TASK_B, {}));
    const changed = (await git(root, 'diff', '--name-only')).split('\n').filter(Boolean).sort();
    assert.deepEqual(changed, ['docs/cli.rst', 'src/flask/cli.py', 'tests/test_cli.py'], 'Task B changed exactly three files');
    assert.ok(b.reviews >= 3, `three reviews (saw ${b.reviews})`);
    assert.ok(b.commands >= 1, 'the pytest command was approved');
    const st = ui.panel.state;
    assert.ok(st.context.estimatedTokens > 0 && st.context.budgetTokens === 8000, 'context budget visible');
    assert.ok(st.context.selections.some((s) => s.path === 'src/flask/cli.py' && s.rationale), 'cli.py chosen with a reason');
    assert.ok(Array.isArray(st.context.skipped), 'skipped items visible');
    assert.ok(st.tools.some((t) => t.label === 'propose_edit') && st.tools.some((t) => t.label === 'run_command'), 'tool activity listed');
    assert.ok(st.text.includes('flask config'), 'streamed summary text');
    assert.ok(st.edits.length === 3, 'three reviewed edits listed');
    console.log('PASS Task B: panel streaming, context block, 3 files reviewed and saved, command approval');
    await git(root, 'checkout', '--', '.');

    // ---------------- Stop (1): a review is certainly pending, then Stop → cancelled, nothing applied, no prompt left
    const previewTabs = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) =>
      t.input instanceof vscode.TabInputTextDiff && t.input.modified.scheme === 'forge-preview');
    const helpersBefore = await fs.readFile(helpers.fsPath, 'utf8');
    ui.newConversation();   // a fresh session: the scripted model starts its plan from the first step
    const reviewTurn = ui.run('agent', 'stop check: pending review of src/flask/helpers.py', {}).catch((e) => e);
    await until(() => ui.panel.state.reviewing, 'a pending review', 30000);
    await until(() => previewTabs().length === 1, 'the review diff tab', 10000);
    await until(() => ui.reviewControlsOpen(), 'the review prompt showing before Stop', 5000);
    await ui.stop();
    await reviewTurn;
    assert.equal(ui.panel.state.outcome, 'cancelled', 'the turn ended cancelled');
    assert.ok(!ui.panel.state.busy && !ui.panel.state.reviewing, 'panel idle after Stop');
    await until(() => previewTabs().length === 0, 'diff tab closed', 5000);
    assert.ok(!ui.reviewControlsOpen(), 'no review prompt or Accept All control left after Stop');
    assert.equal(await fs.readFile(helpers.fsPath, 'utf8'), helpersBefore, 'helpers.py unchanged');
    assert.equal(await git(root, 'status', '--porcelain'), '', 'Stop during review leaves no edits');
    console.log('PASS Stop during a pending review: turn cancelled, diff tab and review prompt closed, file unchanged');

    // ---------------- Stop (2): an approved command is certainly running, then Stop → cancelled, process gone
    const running = async () => (await run('pgrep', ['-f', 'forge-stop-check']).catch(() => ({ stdout: '' }))).stdout.trim().split('\n').filter(Boolean).length;
    assert.equal(await running(), 0, 'no stop-check process before the test');
    ui.newConversation();
    const commandTurn = ui.run('agent', 'stop check: running command', {}).catch((e) => e);
    await until(() => ui.panel.state.command, 'the command approval prompt', 30000);
    ui.commandAnswer(true);
    await until(async () => (await running()) > 0, 'the approved command running', 15000);
    const t0 = Date.now();
    await ui.stop();
    await commandTurn;
    assert.ok(Date.now() - t0 < 10000, `Stop ended the turn in ${Date.now() - t0} ms, not after the 60 s command`);
    assert.equal(ui.panel.state.outcome, 'cancelled', 'the turn ended cancelled');
    await until(async () => (await running()) === 0, 'the command process killed', 5000);
    assert.ok(!ui.panel.state.busy && !ui.panel.state.command, 'panel idle, no command prompt left');
    assert.equal(await git(root, 'status', '--porcelain'), '', 'workspace unchanged');
    console.log('PASS Stop during a running command: turn cancelled within ' + (Date.now() - t0) + ' ms, process killed, workspace unchanged');

    // ---------------- Task C: invalid primary key → fallback banner → reject → workspace unchanged
    const devMock = path.resolve(__dirname, '..', '..', 'scripts', 'dev-mock.sh');
    await run(devMock, ['--break-primary'], { env: process.env });
    try {
      const doc2 = await vscode.workspace.openTextDocument(helpers);
      const sel = { path: 'src/flask/helpers.py', text: doc2.getText(new vscode.Range(start, 0, start + 6, 0)), startLine: start + 1, endLine: start + 6 };
      await withAnswers(ui, 'reject', () => ui.run('inline', TASK_A, { activeFile: 'src/flask/helpers.py', selection: sel }));
      assert.match(ui.panel.state.banner, /^Primary model failed: .*401.* → switched to demo-fallback\/scripted$/, `fallback banner (got: ${ui.panel.state.banner})`);
      assert.equal(await git(root, 'status', '--porcelain'), '', 'Task C leaves the workspace unchanged');
    } finally {
      await run(devMock, ['--restore'], { env: process.env });
    }
    console.log('PASS Task C: fallback banner, rejected proposal, git status clean');
  } finally {
    await ui.shutdown();
  }
};
