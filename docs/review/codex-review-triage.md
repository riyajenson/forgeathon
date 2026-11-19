# Triage of the independent review (`~/forge-review/CODEX-REVIEW.md`, snapshot `db5d4d5`)

Each finding was checked against the code on `main` at `db5d4d5` before any change. Classes:
**CONFIRMED** (the defect is real), **ALREADY FIXED**, **NOT A BUG** (with evidence), **HUMAN STEP** (needs keys,
recording or submission). The "Fix" column lists the branch work; commit hashes are in the last section.

## Blockers

| # | Finding | Verdict | Evidence (at `db5d4d5`) | Fix |
|---|---|---|---|---|
| B1 | No real-model run, video, final PDF or Task B session evidence | HUMAN STEP | No keys were available; `docs/STATUS.md` says so. The demo script already plans the session shot. | Recording rules tightened (real models only, explicit session shot); the rest is in the human steps in `docs/STATUS.md` |
| B2 | An approved command can start after Stop | CONFIRMED | `mcp/command.ts:73` checks `scope.cancelled`, then awaits `snapshot()` (`:83`) and `commandEnv()` (`:90`) before spawning; the `AbortController` is registered only at `:86`, so a cancel during either await is missed and the command runs | Re-check cancel immediately before spawn, register the abort before the first await, handle an already-aborted signal; race tests at both await points |
| B3 | Retry/fallback can start while an approved write is pending or in flight | CONFIRMED | `turn/turn.ts:184–204`: an unsettled `settle()` only sets `effect = 'unknown'`; retry/fallback is gated on `scope.writes`, which `proposeEditTool` increments only after `applyText` returns (`mcp/tools.ts:239`). Approved-but-unexecuted decisions are not counted, the old scope's gate stays open on fallback, and a retry resets the counters (`resetForTurn`) | Approved-but-unfinished writes/commands count as writes; no retry/fallback unless every call settled; old gate closed before any new attempt; watchdog does not fire while our tools are running; tests with a fake TrueForge client |
| B4 | `run_command` bypasses reviewed edits and workspace confinement | CONFIRMED (mitigated, not removed) | `mcp/command.ts:78–92`: lexical cwd check only (no symlink resolution), full `process.env` passed to `bash -c`, any command allowed after approval | Real-path cwd containment, scrubbed environment, timeout and output cap (already present), commands outside a small safe list flagged "unrestricted" in the approval prompt, changes outside review shown; residual risk documented in README and the write-up |

## Issues

| # | Finding | Verdict | Evidence | Fix |
|---|---|---|---|---|
| I1 | A model-supplied regex can freeze the extension host (`(a+)+$`) | CONFIRMED | `mcp/tools.ts:118,134`: `new RegExp(query)` then synchronous `pattern.test(line)` on the host thread | Regex searches run in a worker thread with a deadline; reproducer test |
| I2 | Watchdog/cancel do not bound a stalled TrueForge request | CONFIRMED | `trueforge/attempt.ts:124` awaits `sessions.cancel` before the cancel timer starts (`:130`); the watchdog only calls `cancel()`; stream reads are not abortable; SDK timeout is 3600 s (`trueforge/sdk.ts:18`) | Cancel request bounded; SDK calls get an abort signal; a cancelled or stalled attempt is force-finished after a bounded grace period; exactly one terminal event; tests with a never-responding fake |
| I3 | Undo is not verified after save-time formatting; new-file receipt has the pre-save hash | CONFIRMED | `extension/src/review.ts:176` hashes the restored buffer before `save()` only; `:138` builds `undo.expectedPostSha256` before the save (`:146` updates only the local receipt) | Post-save hash in both receipts; undo saves without save participants and verifies the result, keeping the receipt on failure; VS Code tests with a formatting save participant |
| I4 | Ignored/secret-bearing files can reach the model; messages not sanitized | CONFIRMED | `searchWorkspaceTool` uses the raw lister (`mcp/tools.ts:123`); the index reads only the root `.gitignore` (`context/workspace-index.ts:76`); `safeMessage` only truncates (`trueforge/errors.ts:36`) | One ignore policy (nested `.gitignore`, negations, default excludes) for search, listing, indexing and `read_file`; secret-looking files refused; key-like strings redacted in displayed messages |
| I5 | Context silently stops at 500 listed files | CONFIRMED | `extension/src/editorPort.ts:70` defaults to 500 and stops walking; `buildIndex` calls `listFiles()` without a limit | Harness requests an explicit limit, the editor allows it, truncation is reported in the context report's skipped list |
| I6 | Tests overstate completion | CONFIRMED | `smoke.ts:166` docstring check only searches `/off/`; `:158` accepts any review count; `extension/test/review.cjs:103` prints "all six apply outcomes" without asserting `failed_before_apply`; command cancel test waits 300 ms | Docstring check asserts every false value inside the docstring; check names match what they check; `failed_before_apply` asserted; race tests; doc claims corrected |
| I7 | Fallback depends on narrow error strings | CONFIRMED | `trueforge/errors.ts:10–13`: only `(401)`/`(403)` count as auth; any other `[Model Error]` (e.g. an invalid Gemini key, which Google reports as HTTP 400 "API key not valid" — ASSUMED from provider behaviour, not observed here) is `OTHER`, which disables fallback | Auth detected by status or wording; any other model error before a write falls back (no retry); tests with several provider formats |
| I8 | Demo script allows a mock recording and assumes scripted details | CONFIRMED | `docs/DEMO-SCRIPT.md`: "unless no real model is available"; promises `find_symbol` and two hunks | Real models mandatory; session shot names what must be visible; no promise of specific tool choices or hunk counts |
| I9 | Clean-clone gaps (build only under mock quick start; smoke default path; missing `AGENTS.md`) | CONFIRMED | `README.md` real-model section has no install/build step; `smoke.ts:125` defaults to `~/projects/flask-3.1.3` while the README prepares `~/flask-demo`; `AGENTS.md` is not in the repository | Shared install section; smoke default follows the README; checklist made self-contained |
| I10 | Cancelled reviews stay visible; command state lingers | CONFIRMED (UX) | `extension/src/inlineReview.ts:90` resolves and hides the picker but leaves the diff tab; the panel's command block clears only on `done` | Cancel closes the review's diff tab and tells the user; the panel's command block clears when either UI answers |

## Rubric/eligibility table rows

| Item | Verdict | Note |
|---|---|---|
| Demo shows Task B TrueForge session | HUMAN STEP | Shot exists (`DEMO-SCRIPT.md` 2:20–2:35); made explicit and mandatory |
| Demo video 0/10, PDF 8/15 | HUMAN STEP | Recording, timestamps, team, models and cost need the human |
| Unbounded retained turns/events/receipts (`harness.ts:48`, `event-buffer.ts`, `review.ts:34`) | CONFIRMED, not fixed | Grows by one turn's events per turn for the editor's lifetime; negligible for a demo session. Listed as a known limitation |

## Nits

| # | Finding | Verdict | Fix |
|---|---|---|---|
| N1 | `contracts/README.md` says protocol 0.4.0 | CONFIRMED | Updated with the protocol bump |
| N2 | `extension/test/review.cjs` hard-codes 0.4.0 | CONFIRMED | Uses the shipped protocol constant |
| N3 | `render-writeup.sh` does not fail outside 1–3 pages; renderer not pinned | CONFIRMED | Fails outside 1–3 pages; `md-to-pdf` pinned to an exact version |
| N4 | Demo docs say masked config can be shared "safely" | CONFIRMED | Wording states exactly which keys are masked |
| N5 | Harness `engines` says Node ≥ 20, README says ≥ 22.14 | CONFIRMED | Aligned to ≥ 22.14 |
| N6 | Session/model caches live for the host lifetime | CONFIRMED, not fixed | Rerunning setup while the editor runs can show a stale model name; documented |

## Questions for the authors

1. Official PDF: held by the human; the task wording in the repository is copied from it. 2–3: answered by the
   human steps (rehearsal, recording). 4: no — command approval is not meant to permit unreviewed writes; the
   mitigation above makes that visible, and the residual risk is documented. 5: Undo restores the exact
   pre-edit text (saved without save participants); cancellation keeps previously approved files (by design,
   each remains undoable).

## Fix log

| Finding | Commits |
|---|---|
| B2 | `4c429ec` (+ turn-level race in `5f4a9cb`) |
| B3 | `5f4a9cb` |
| B4 | `4c429ec`, `b24f272` (contract flag), `87d5ca9` (editor warning), `61bc700`, README/write-up in `3e20525` |
| I1 | `9315123` |
| I2 / cancellation bounds | `b241ae5`, `5f4a9cb` |
| I3 | `acc9f62` |
| I4 | `9315123` (ignore policy, credentials files), `612ddb8` (redaction) |
| I5 | `9315123`, `492c6ef` |
| I6 | `46ae7be`, `acc9f62` (failed_before_apply), docs claims in `3e20525` and the status/checklist commit |
| I7 | `612ddb8` |
| I8 | `3e20525` (demo script) |
| I9 | `3e20525` (README install section), `46ae7be` (smoke default), checklist made self-contained |
| I10 | `e6fd9fa`, `87d5ca9` |
| N1 | `b24f272` · N2 `e2dd14e`/`acc9f62`/`87d5ca9` · N3 `3f9fb7e` · N4 `e62dc18` · N5 `e62dc18` |

Verification after the fixes is in `docs/STATUS.md` ("Final verification on main after the review fixes").
