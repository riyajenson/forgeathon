# Editor handoff to Codex — 2026-11-19 (written ~00:50 IST, for the 03:40 resume)

> **Historical.** Superseded by `docs/STATUS.md` and the README; kept as a record of the hand-over.

While you were away I owned `extension/**` and `contracts/**` (temporary, authorised by the user). I
preserved your work exactly, then made small additions on top. Nothing was pushed.

## 1. What I found and preserved

- Your branches `editor/e1-scaffold` → `e2-bridge-inline-review` → `e3-agent-panel` → `e4-harness-wiring`
  (worktree `~/projects/forgeathon-editor`) were intact. `e1` is a root commit holding only `extension/`.
- `e4-harness-wiring` had uncommitted work (13 files: `connect.ts`, `driver.cjs`, `live.cjs`, changes to
  panel/turn/review/workbench/package.json/tests). I committed it **unchanged** as
  `b420dd8 editor: wire turns and the panel to forge-harness`. It compiled cleanly as committed.
- Your three uncommitted contract edits (README status, outcome/compile checks in `contract.test.ts`, the
  post-save undo comment in `edits.ts`) were committed **byte-identical** as
  `51e9224` on `contracts/v0.4.1`, followed by a separate `9b0652c contracts: bump protocol version to
  0.4.1` (you had not bumped it). `tsc -p contracts` passes. Merged into `harness/p4-context-engine`.

## 2. What I added (branch `editor/e5-review-actions`, based on `editor/e4-harness-wiring`)

| Commit | Change |
|---|---|
| e5a8936 | `connect.ts`: require harness protocol **0.4.1** (was 0.4.0; the harness now reports 0.4.1) |
| ca29850 | Accept All / Reject All: a non-modal notification appears with the diff (`Accept All`, `Reject All`, `Choose Hunks...`), plus commands `forgeathon.acceptAllHunks` / `forgeathon.rejectAllHunks`; the hunk picker now starts with every hunk checked |
| 436d70f | `applyText` creates approved **new files** (`WorkspaceEdit.createFile`, `overwrite:false`, `ignoreIfExists:false`, contents = the reviewed text) instead of refusing; undo of a created file deletes it (still guarded by the post-edit hash) |
| 2e6f6f5 | Inline turns show a cancellable progress notification ("Forge inline edit"); Cancel calls `stop()` |
| 8dde0c0 | Agent panel: **Allow once / Deny** buttons for `run_command` (same single decision as the quick pick, whichever answers first) |
| (this file) | handoff |

Everything else is yours, unchanged: EditorPort (`readText` dirty-buffer-first with symlink checks,
`listFiles`, `applyText` with the six outcomes, single WorkspaceEdit then save, guarded undo), diff-editor
review, panel (streaming text, tool activity, context block with skipped items, fallback/error banner, Stop,
TrueForge session link), TurnController (sequence checks, stop/cancel), status-only logger.

## 3. Decisions made

1. Extended your code; no rewrites. Per-hunk review stays the diff editor + multi-select quick pick (no
   CodeLens), with Accept All / Reject All added as the quick path.
2. New-file creation implemented (Task B may add a file). It never overwrites: if the file appeared in the
   meantime, VS Code declines and the result is `failed_before_apply`.
3. Protocol pin moved to 0.4.1 to match `contracts/v0.4.1` (patch bump for your compatible edits).
4. No automated Extension Development Host run: `@vscode/test-electron` downloaded VS Code 1.146.0 for
   Linux, but it cannot start in this WSL without system libraries (`libnspr4`, `libnss3`, … → needs
   `sudo apt install`), which is outside my scope. Verification here = `npm run compile` after every change
   plus the harness's own tests (which exercise the same contract against real TrueForge).

## 4. Build and launch the Extension Development Host

```bash
# Harness (the extension imports it via "forge-harness": "file:../src/harness")
cd ~/projects/forgeathon            # a checkout that has src/harness (harness branch or merged main)
npm --prefix src/harness ci && npm --prefix src/harness run build

# Extension
cd ~/projects/forgeathon-editor/extension
npm install                          # your node_modules/forge-harness currently links to ../../../forgeathon/src/harness
npm run compile
```

After everything is merged into one checkout, `npm install` in `extension/` re-links `forge-harness` to that
checkout's `src/harness`.

TrueForge + agents (see `docs/internal/HANDOFF-0100.md` on the harness branch for details):

```bash
mkdir -p ~/forge-demo
OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1"]' MODEL_HTTP_CONNECT_TIMEOUT_MS=3000 MODEL_HTTP_MAX_RETRIES=1 \
  SQLITE_PATH=$HOME/forge-demo/tf.sqlite npx -y @truefoundry/trueforge@0.185.1
cp config/models.example.json config/models.json && export ANTHROPIC_API_KEY=... OPENAI_API_KEY=...
node scripts/setup-trueforge.mjs
```

Launch: in Windows VS Code run **WSL: Connect to WSL**, open `~/projects/forgeathon-editor/extension`, press
**F5** ("Launch Forge editor"). In the Extension Development Host open a **copy** of Flask 3.1.3 (never the
pristine `~/projects/flask-3.1.3`).

Manual checklist:
1. Task A: open `src/flask/helpers.py`, select `get_debug_flag`, **Ctrl+Alt+I**, type the instruction →
   progress notification → diff editor + "Review 2 hunks" notification → Accept All → file saved →
   `FLASK_DEBUG=off python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"` prints False.
   Also try **Forge-a-thon: Undo Last Reviewed Edit**.
2. Task B: **Forge-a-thon: Open Agent Panel**, send the Task B text → Context block (used/budget, reasons,
   skipped) → tool activity → one diff per file (choose hunks / accept all) → command approval in the panel →
   **Open TrueForge session** → `pytest tests/test_cli.py -q`, `flask --help`.
3. Stop: start a turn and press Stop (panel) or Cancel (inline progress) → status shows cancelled, `git status`
   shows no partial edits beyond accepted ones.
4. Task C: re-run setup with an invalid primary key (`ANTHROPIC_API_KEY=bad node scripts/setup-trueforge.mjs`),
   repeat Task A → banner "Primary model failed: … → switched to …", then restore the key.

## 5. Left for you / known issues

- Not yet run in a real Extension Development Host by me (see decision 4). Please run the checklist first.
- `listFiles` defaults to 500 files; the harness context engine calls it without a limit. Fine for Flask
  (235 files); raise it or pass a limit for larger repos.
- `node_modules/forge-harness` is a symlink to the harness worktree; re-run `npm install` after merging.
- Inline turns close their TrueForge session afterwards (your design); agent-panel turns reuse one session.
- Command approval quick pick and panel buttons both appear; the first answer wins.
- No CodeLens per hunk (the picker is per hunk). Optional polish if time allows.
- Your opt-in tests (`test/*.cjs`, `live.cjs`) were not run (need an Extension Development Host).
