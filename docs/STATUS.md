# Project status

Updated: 2026-11-19 ~11:45 IST (final for today). The repository is submission-ready except for the
human steps at the end of this file (models and keys, a real-model rehearsal, push, video, PDF, form).

## MVP checklist

Legend: ✅ verified (how) · 🟡 needs a human step · ❌ missing

"UI e2e" = `scripts/test-extension-e2e.sh`: a real VS Code 1.146 window (WSLg) runs the extension's Workbench
against TrueForge 0.185.1 + the scripted demo model on a copy of Flask 3.1.3.
"Harness e2e" = `scripts/e2e-mock.sh`: the same tasks through `createHarness` without a GUI, plus the Flask
verification commands. **No real model has been used yet (no keys were available).**

| Item | Status | Evidence |
|---|---|---|
| Task A: inline edit → diff → accept → saved | ✅ | UI e2e + harness e2e (`FLASK_DEBUG=off` → False, `N` → False, `1` → True) |
| Task A: per-hunk review | ✅ | Extension suites in a real VS Code window (partial approval, all six apply outcomes) |
| Task A: undo | ✅ | UI e2e (undo restores the file; `git status` clean) |
| Task A: keybinding, input box, notifications | 🟡 | Contributed; only checkable by hand → `docs/MANUAL-TEST.md` |
| Task B: panel streaming + tool calls (incl. deferred `find_symbol` via `call_tool`) | ✅ | UI e2e + harness e2e |
| Task B: context block (used/budget, reasons, skipped) | ✅ | UI e2e; `src/flask/cli.py` ranks #1 (Flask ranking regression test) |
| Task B: ≥3 files, per-file review, verification | ✅ | Exactly `cli.py`, `test_cli.py`, `docs/cli.rst`; `pytest tests/test_cli.py -q` 57 passed; `flask --help` lists `config`; masked JSON |
| Task C: invalid primary → fallback, workspace unchanged | ✅ | UI e2e (panel banner, `git status` clean) + harness e2e; fallback also shown as a VS Code notification |
| Cancel: Stop ends the turn, review closes, no partial edits | ✅ | UI e2e + harness integration (cancel while paused / streaming / racing an apply) |
| TrueForge session link | ✅ | UI e2e (link present); opening it is manual |
| Demo without keys | ✅ | `scripts/dev-mock.sh` |
| Real model (Tasks A, B, C) | 🟡 | Needs keys → steps below |

### Final verification on main (2026-11-19 11:20–11:40 IST)

| Check | Result |
|---|---|
| `npm --prefix src/harness test` | 55/55 |
| `npm --prefix src/harness run test:integration` (fresh TrueForge 0.185.1) | 17/17 |
| `scripts/test-extension.sh` (extension suites in VS Code) | 4/4 |
| `scripts/e2e-mock.sh` | 15/15 checks (A 1.8 s, B 5.1 s with 9 tool calls / 3 reviews, C 1.2 s) |
| `scripts/test-extension-e2e.sh` | 4/4 (Task A, Task B, Stop, Task C) |
| `tsc -p contracts`, extension compile | clean |
| Fresh clone (temp dir) following the README | builds; 55/55 unit; setup dry run; README Flask commands and Task A/B verification commands work verbatim; both e2e scripts pass |
| Secret scan of all 120 commits (key patterns + secret-looking assignments) | nothing found |
| `.gitignore` covers `config/models.json`, `.data`, `logs`, `dist`, `out`, `node_modules`, `*.sqlite`, `.env`, the rendered PDF | yes (checked with `git check-ignore`) |
| Write-up PDF (`scripts/render-writeup.sh`) | renders, 3 pages, headings in the required order |

## Phase 2 (score-relevant quality) — done

- **Context (15 pts):** code ranks above docs/tests that echo the task wording; `src/flask/cli.py` #1 for Task B
  and four unrelated Flask tasks rank their source file first (regression test). Reasons are plain English;
  budget and skipped items are in the panel; `@file:` / `@symbol:` covered by tests.
- **Resilience:** 429 waits for the provider's `Retry-After` hint (default 5 s, cap 30 s) before the single
  retry; retry/fallback rules unchanged; per-turn log at `~/.forge/turns.jsonl` (models, attempts, tokens,
  timing; no content). Integration-tested against TrueForge.
- **Diff safety:** stale-base refusal (harness and editor), partial accept, no overwrite of a file that appeared
  after review, undo of created files — all tested.
- **TrueForge depth:** deferred `find_symbol` / `list_files` (loaded through `call_tool`, visible in the session
  view); approvals for `propose_edit` / `run_command`; compaction configured (60k tokens) but not reached by the
  demo tasks — documented honestly.
- **run_command:** git status before/after, changed files reported, counts as a write; workspace `.venv` first on PATH.

## Branch map

`main` is ahead of `origin/main` (`1317300`) by today's merges; nothing pushed today. All branches below are
merged into `main` with `--no-ff`.

| Branch | Content |
|---|---|
| docs/branching, contracts/v0.4.0, contracts/v0.4.1 | convention; shared contracts (protocol 0.4.1) |
| harness/p0-spike … p5-smoke, editor/e1-scaffold … e5-review-actions | built before today (see git log) |
| editor/e6-edh-tests | extension tests in a real VS Code window without sudo; undo fix for WSL |
| harness/p6-demo-mode | scripted demo model, `dev-mock.sh`, `e2e-mock.sh`, UI e2e test, venv-aware `run_command` |
| harness/p7-quality | context ranking, 429 backoff, turn log, deferred tools, panel model/token display |
| harness/p8-model-config | provider examples (Gemini, Groq, OpenRouter, Anthropic, OpenAI), reasoning efforts |
| docs/submission | README, LICENSE, notices, write-up + PDF script, demo script, manual test, checklist, `.gitignore` |
| editor/e7-notifications, editor/e8-test-cache | fallback/error notifications; shared VS Code test download |
| harness/p9-real-model-readiness | inline agent stops after a rejection |
| docs/status | this dashboard |

## Decisions made (today)

1. No model keys in the environment → no real-model runs; everything developed and tested with the scripted demo model.
2. VS Code's Linux build runs on WSLg after fetching libnspr4/libnss3/libasound2 with `apt-get download` (no sudo); `scripts/test-extension.sh` does this automatically.
3. Undo of an approved new file uses `workspace.fs.delete(useTrash: false)`; the trash is unsupported on WSL mounts (found by the real-window test).
4. The demo model is a scripted state machine calling the same tools a real model would; its edits were verified on Flask 3.1.3.
5. Test virtualenvs pin `pytest==9.0.2` (Flask's lockfile); with Python 3.14 two unrelated Flask tests fail on the pristine checkout too (`test_async_view`, `test_bad_environ_raises_bad_request`); task verification uses `tests/test_cli.py`.
6. `run_command` puts a workspace `.venv`/`venv` first on PATH.
7. Context ranking: docs/tests weighted 0.6 for their own matches (they rise through test/doc pairing); not tuned to Task B alone (five-task regression test).
8. Example config defaults: Gemini primary, Groq fallback (different providers, both with free tiers); final choice is yours. Verified on TrueForge 0.185.1 that built-in providers are named `<type>/<model>`.
9. Licence MIT (all dependencies permissive); root `.gitignore` added; write-up PDF is a generated file (not committed).
10. Fallback and errors also appear as VS Code notifications (the panel may be closed during an inline edit).
11. The inline agent stops after the user rejects its change (avoids repeated proposals in Task C with a real model).

## Known issues and risks

- **Real models untested.** Tool-calling quality, latency and cost are unknown until the rehearsal. Gemini goes
  through TrueForge's Vercel AI SDK provider (`parametersJsonSchema`), which should accept our tool schemas;
  if the primary errors on schemas, switch providers in `config/models.json` (config-only).
- Compaction is configured but never triggered by the demo tasks.
- A fallback starts a new TrueForge session (no earlier panel history).
- `run_command` can change files outside review (reported; counts as a write).
- Hunk review uses a picker, not per-hunk CodeLens.
- Scratch data from today: `~/forge-dev` (test databases, logs), `~/.forge-mock` (demo-mode databases),
  `/tmp/forge-readme-*` (walkthrough clone), `~/forge-backup-untracked-extension-20261118-191829` (old untracked
  copy from last night) — all safe to delete. `~/.cache/forge-vscode` and `~/.cache/forge-vscode-libs` are reused by the tests.

## Needs human — steps for 20 Nov, in order

1. **Choose models + export keys.** `cp config/models.example.json config/models.json`, set
   `agents.primaryModel` / `agents.fallbackModel` (different providers), `export <PROVIDER>_API_KEY=…` for both.
2. **Setup + one real-model rehearsal.** Start TrueForge (README step 2), then
   `node scripts/setup-trueforge.mjs` → must end with "models available: … (primary), … (fallback)".
   Then `node scripts/smoke-real-model.mjs --tasks A,C` and, if green, `--tasks B` once. Note tokens/time from
   the summary and `~/.forge/turns.jsonl` for the write-up's cost line.
3. **Manual VS Code checklist:** `docs/MANUAL-TEST.md` (≈ 20 min).
4. **Push:**
   ```bash
   cd ~/projects/forgeathon && git push origin --all     # main + every branch (nothing is force-pushed)
   ```
   Then confirm the repository is public (open it signed out).
5. **Record** per `docs/DEMO-SCRIPT.md` (≤ 4:00; Tasks A, B, C in order; no cut between instruction and diff).
6. **Write-up:** fill team, Team ID, repo/video URLs, final models + cost, `[mm:ss]` timestamps and the
   real-model limitation line in `docs/writeup/WRITEUP.md`; `scripts/render-writeup.sh` (must say 1–3 pages).
   Commit the text changes, push.
7. **Submit** https://forms.gle/htyWGFJRBgsg3qmx6 (repo link, PDF, video link, Team ID); check every link signed out.
