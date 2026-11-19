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
  try {
    await runTests({
      version: process.env.FORGE_VSCODE_VERSION || '1.146.0',
      extensionDevelopmentPath: ext,
      extensionTestsPath: test,
      extensionTestsEnv: { ...process.env },
      launchArgs: [workspace, '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--disable-gpu',
        '--user-data-dir', fs.mkdtempSync(path.join(os.tmpdir(), 'forge-edh-profile-'))],
    });
    console.log(`EDH TESTS PASSED: ${path.basename(test)}`);
  } catch (error) {
    console.error(`EDH TESTS FAILED: ${path.basename(test)}: ${error && error.message}`);
    process.exitCode = 1;
  } finally {
    if (!given) fs.rmSync(workspace, { recursive: true, force: true });
  }
})();
