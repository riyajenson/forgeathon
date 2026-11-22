// Runs extension tests inside a real VS Code (Extension Development Host) with an empty temporary
// workspace. Usage: node test/run-edh.cjs [test file, default panel.cjs] — see scripts/test-extension.sh.
const { runTests } = require('@vscode/test-electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

(async () => {
  const ext = path.resolve(__dirname, '..');
  const test = path.join(__dirname, process.argv[2] || 'panel.cjs');
  // FORGE_EDH_WORKSPACE: open this folder instead of an empty temporary one (it is not deleted).
  const given = process.env.FORGE_EDH_WORKSPACE;
  const workspace = given || fs.mkdtempSync(path.join(os.tmpdir(), 'forge-edh-'));
  const profile = process.env.FORGE_TEST_CDP_PROFILE || fs.mkdtempSync(path.join(os.tmpdir(), 'forge-edh-profile-'));
  // Keep the real-frame responsiveness benchmark on the normal renderer. GPU-off
  // software rendering makes requestAnimationFrame timing depend heavily on host load.
  const gpuEnabled = process.env.FORGE_TEST_GPU
    ? process.env.FORGE_TEST_GPU === '1'
    : path.basename(test) === 'responsiveness.cjs';
  const gpuArgs = gpuEnabled ? [] : ['--disable-gpu'];
  // The responsiveness benchmark gates on requestAnimationFrame timing. Chromium slows rAF to ~1 Hz in windows it
  // considers hidden or occluded (another window on top, a locked screen); that is not a stall in Forge, so turn
  // the throttling off for that test: a slow frame then means the webview or the extension host really stalled.
  const frameArgs = path.basename(test) === 'responsiveness.cjs'
    ? ['--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling']
    : [];
  // TRUEFORGE_URL: point the extension at that TrueForge (e.g. the scripted one on another port) instead of
  // the default http://127.0.0.1:8790, which may be a real-model TrueForge.
  if (process.env.TRUEFORGE_URL) {
    const settings = path.join(profile, 'User', 'settings.json');
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    let current = {};
    try { current = JSON.parse(fs.readFileSync(settings, 'utf8')); } catch { /* new profile */ }
    fs.writeFileSync(settings, JSON.stringify({ ...current, 'forge.trueforgeUrl': process.env.TRUEFORGE_URL }, null, 1));
  }
  try {
    await runTests({
      version: process.env.FORGE_VSCODE_VERSION || '1.146.0',
      // One shared download for every checkout; the first download (~390 MB) can be slow.
      cachePath: process.env.FORGE_VSCODE_CACHE || path.join(os.homedir(), '.cache', 'forge-vscode'),
      timeout: 120000,
      extensionDevelopmentPath: ext,
      extensionTestsPath: test,
      extensionTestsEnv: { ...process.env },
      // FORGE_TEST_CDP_PROFILE (live.cjs): that profile directory, with a DevTools port so the test can drive native UI.
      launchArgs: [workspace, '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', ...gpuArgs, ...frameArgs,
        ...(process.env.FORGE_TEST_CDP_PROFILE ? ['--remote-debugging-port=0'] : []),
        '--user-data-dir', profile],
    });
    console.log(`EDH TESTS PASSED: ${path.basename(test)}`);
  } catch (error) {
    console.error(`EDH TESTS FAILED: ${path.basename(test)}: ${error && error.message}`);
    process.exitCode = 1;
  } finally {
    if (!given) fs.rmSync(workspace, { recursive: true, force: true });
    // The temporary VS Code profile (~20 MB) is removed too, so repeated runs do not fill a small /tmp.
    if (!process.env.FORGE_TEST_CDP_PROFILE) fs.rmSync(profile, { recursive: true, force: true });
  }
})();
