# Project status

Updated: 2026-11-19 10:45 IST (end of Phase 1). Owner while you are away: harness + editor + contracts + docs.

## MVP checklist

Legend: ✅ verified (how) · 🟡 implemented, not verified end to end · ❌ missing

"UI e2e" = `scripts/test-extension-e2e.sh`: a real VS Code 1.146 window (WSLg) runs the extension's Workbench
against TrueForge 0.185.1 + the scripted demo model on a copy of Flask 3.1.3.
"Harness e2e" = `scripts/e2e-mock.sh`: same tasks through `createHarness` without a GUI, plus the Flask
verification commands. Neither uses a real model (no keys available).

| Item | Status | Evidence |
|---|---|---|
| Task A: inline edit → diff → accept → saved | ✅ | UI e2e + harness e2e (`FLASK_DEBUG=off` → False, `N` → False, `1` → True) |
| Task A: per-hunk review | ✅ | Extension tests (`review.cjs`: partial approval, all six outcomes) in a real VS Code window |
| Task A: undo | ✅ | UI e2e (undo restores the file; `git status` clean) |
| Task A: keybinding + input box | 🟡 | Contributed (Ctrl+Alt+I); only checkable by hand → docs/MANUAL-TEST.md |
| Task B: panel streaming + tool calls | ✅ | UI e2e (streamed text, tool list incl. propose_edit / run_command) |
| Task B: context block (used/budget, reasons, skipped) | ✅ | UI e2e (8000 budget, cli.py with reason, skipped list) |
| Task B: ≥3 files, per-file review, pytest passes | ✅ | UI e2e (exactly cli.py, test_cli.py, docs/cli.rst) + harness e2e (`pytest tests/test_cli.py -q`: 57 passed; `flask --help` lists config; masked JSON) |
| Task C: invalid primary → fallback banner, workspace unchanged | ✅ | UI e2e (banner "Primary model failed: … 401 … → switched to …", `git status` clean) + harness e2e |
| Cancel: Stop ends the turn, review closes, no partial edits | ✅ | UI e2e (Stop during the first review → no edits, panel idle) + harness integration tests |
| TrueForge session link | ✅ | UI e2e (session link present); opening it in a browser is manual |
| Demo-without-keys mode | ✅ | `scripts/dev-mock.sh` (scripted model + fresh TrueForge database + setup) |
| Real model | ❌ | No keys in the environment; needs a human (see below) |

Test totals on main: harness unit 51/51 · harness integration 16/16 (needs TrueForge) · extension (real VS Code) 4/4 suites · UI e2e 4/4 · harness e2e 15/15 checks.

## Branch map

`main` = local tip (not pushed since `1317300`). Merged today: `docs/status`, `editor/e6-edh-tests`, `harness/p6-demo-mode`.

| Branch | Content |
|---|---|
| docs/branching | branching and commit convention |
| contracts/v0.4.0 → v0.4.1 | shared contracts (protocol 0.4.1) |
| harness/p0-spike | TrueForge 0.185.1 spike + findings |
| harness/p1 → p2a → p3 → p4 → p5 | harness (review core, MCP, turn runner, setup, context engine, smoke) |
| editor/e1 → e5 | VS Code extension |
| editor/e6-edh-tests | extension tests in a real VS Code window (no sudo), undo fix for WSL |
| harness/p6-demo-mode | scripted demo model, dev-mock.sh, e2e-mock.sh, UI e2e test |
| docs/status | this dashboard |

## Decisions made (today)

1. No model keys in the environment: no real-model runs; everything is developed and tested against the scripted demo model.
2. VS Code's Linux build runs on WSLg after fetching libnspr4/libnss3/libasound2 with `apt-get download` (no sudo) into `~/.cache/forge-vscode-libs`; `scripts/test-extension.sh` does this automatically.
3. Undo of an approved new file deletes it with `workspace.fs.delete(useTrash: false)`; the trash is not supported on WSL mounts (found by the real-window test).
4. The demo model is a scripted state machine that calls the same tools a real model would; its Task A/B edits were verified on Flask 3.1.3.
5. Test virtualenvs pin `pytest==9.0.2` (Flask's uv.lock); newer pytest breaks an import in Flask's own `tests/test_cli.py`. Under Python 3.14, two unrelated Flask tests fail on the pristine checkout too (`test_async_view`, `test_bad_environ_raises_bad_request`); the task verification uses `tests/test_cli.py` only.
6. `run_command` puts a workspace `.venv`/`venv` first on PATH, so `python -m pytest` works without activating a shell.

## Needs human

1. Choose the real primary/fallback models, export their keys, run `node scripts/setup-trueforge.mjs` and one real-model rehearsal (`node scripts/smoke-real-model.mjs --tasks A,C` then `B`).
