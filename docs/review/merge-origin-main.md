# Merge of origin/main into main (2026-11-19)

## Setup

- **Sides:**
  - Our `main` was at `7bf9b38`.
  - `origin/main` was at `fe72740`, which is PR #3 (`harness/p10-execution-safety`: `13194bd`, `45b3b9b`)
    and PR #4 (`harness/p11-context-readiness`: `2395e27`, `286815c`), by another contributor.
  - The merge base was `db5d4d5`, the morning's status merge, from before our review fixes.
- **Method:** `git merge origin/main` on branch `integrate/origin-main`. There was no rebase and no remote
  history was rewritten. `main` was fast-forwarded only after every check passed.
- **Decisions taken with the user** (two different safety behaviours):
  1. **run_command:** keep **both layers**: origin's bubblewrap protection plus our approval controls.
  2. **Unsettled tools:** adopt origin's **hold until idle**.

## What came from origin and how it relates to ours

| Origin commit | What it changes | Relation to ours | Resolution |
|---|---|---|---|
| `13194bd` command protection, cancel races | `run_command` runs in bubblewrap: read-only host and checkout, private `/tmp`/`/run`, `--unshare-all` (no network), minimal env (PATH, VIRTUAL_ENV, locale; no keys). Fails closed without bwrap. Cancellation checked after every preparation step; injectable `CommandRuntime` for tests; `confinedCwd`; agent instruction about protection; README prerequisite; `docs/harness/EXECUTION-SAFETY.md` | **Overlap:** B2 (never start after Stop: our `4c429ec`, tests "Stop right after approval", "Stop after preparation, immediately before spawn", turn-level B2), B4 (real-path cwd, scrubbed env: `4c429ec`, symlink and env tests). **New:** the sandbox itself, fail-closed check, runtime injection, abort-before-listener handling, escalation-once kill | One implementation (`src/harness/mcp/command.ts`): origin's structure (runtime injection, per-step cancel checks, bwrap spawn, minimal env, once-only SIGKILL escalation) with ours kept: `commandTestHooks.beforeSpawn` and the final synchronous cancel check, specific cwd error messages, "(outside review)" change report as a backstop, the "credential-like variable(s) withheld" line, and the ⚠ Unrestricted label, budget and auto-approval in the turn. `confinedCwd` is used for the cwd check. **Added in the merge:** `protectedArgs(..., visible)` binds the virtualenv read-only, because a venv under `/tmp` (the smoke run and UI e2e layout) was hidden by the private `/tmp`. The ⚠ warning text now says "write-protected and offline, but can read any file you can and run any program" (it said "not sandboxed") |
| `13194bd` tests | 7 sandbox tests (`protectedTest` skips without bwrap), fake-runtime cancel tests, fail-closed test, abort-during-spawn, symlink escape, protectedArgs shape. Integration: the `echo made > made.txt` command must not write | Our tests asserted writes happened (changed-files report) | Origin's write-protection assertions adopted. Our tests kept and adapted: Stop-before-spawn (now `protectedTest`), background-child kill (observed on stdout since files are read-only), env withheld (`protectedTest`), symlink cwd, listed/auto-approvable. **New:** "a virtualenv outside the workspace under /tmp stays visible (read-only)", "a file that still changed is reported as changed outside review (backstop)" via the fake runtime. Integration keeps origin's read-only assertion plus our "flagged unrestricted" assertion |
| `13194bd` agent instruction | forge-coder: commands run read-only, no network; never edit with shell; use temp dirs; report missing protection | Our forge-coder instructions were rewritten (explore / edit / verify, 2-command budget) | Ours kept; origin's guidance added to the Verify phase in one sentence |
| `45b3b9b` hold until idle | If tools are unsettled after the settle timeout: cancel the scope, record `TOOLS_UNSETTLED`, emit error (effect unknown), wait for `scope.waitForIdle()`, end with `done: error`; no retry or fallback | **Overlap:** our B3 (`5f4a9cb`): bounded settle, then effect unknown, no retry or fallback, the turn ends while the tool may still run | **Origin's behaviour adopted** (user decision). Ours kept around it: `closeApprovals()` (unused approvals can never run later), cancel on non-done. Messages merged so both test suites hold: error "… blocked until it finishes (no retry or fallback) …", status "N tool call(s) still running …; waiting for them". Origin's `settlement.test.ts` (3 tests) and our B3 test both pass |
| `2395e27` retrieval coverage | Index lists up to 2,000 files and reports the cap; unreadable or vanished files reported as skipped; unreadable `.gitignore` refuses indexing; index skips shown in the context report (top 20 plus an "additional omissions" line); budget floor 500 → 1 | **Overlap:** our `9315123` / `492c6ef` (one ignore policy for listing, search and index with nested `.gitignore` files; listing up to 20,000 files with truncation reported) | Our `visibleFiles` / `IgnorePolicy` kept (stronger: nested ignores, 20,000 files). Ported onto it: `IgnorePolicy` now always tries the root `.gitignore` and records unreadable ones; `buildIndex` refuses indexing if any is unreadable; per-file unreadable/vanished reporting; engine changes (index skips in the report, overflow line, budget floor 1) as origin wrote them. `INDEX_FILE_LIMIT` is kept as an alias of `LIST_LIMIT` (20,000) and the truncation entry uses origin's path `.` and "coverage may be incomplete" wording. Origin's 5 context tests pass unchanged; our listing-cut test updated to path `.`. `docs/harness/CONTEXT-READINESS.md` updated for 20,000 |
| `286815c` submission evidence gate | `scripts/check-submission.mjs` (write-up headings and placeholders, real A/B/C evidence fields), its tests, `config/rehearsal.example.json`, `docs/harness/CONTEXT-READINESS.md`, STATUS header | **New** | Kept as is. Its STATUS header line is folded into our STATUS header. The checker currently fails as designed (team/URL placeholders, no `docs/writeup/rehearsal.json`) |
| README (`13194bd`) | bubblewrap prerequisite | Our README was rewritten | Prerequisite added; Safety model, Troubleshooting and Testing sections updated (sandbox, fail closed, read-only output, evidence gate) |
| STATUS (`286815c`) | header wording | Ours far ahead | Ours kept; origin's points (mock evidence ≠ readiness, run the checker) included |

Nothing from either side was dropped. Our behaviour that origin did not have is kept unchanged:

- command budget, narrowed auto-approval, the ⚠ Unrestricted label;
- argument-shape hint, JSON-string `edits`;
- approval closing, the model meter;
- extension settings and the protocol 0.4.4 contract.

The protocol needed no change.

## Documentation updated for the merge

These now say that `run_command` is write-protected and offline, but not confidential, and that it fails
closed without bubblewrap:

- README
- write-up (architecture guardrails, limitations, "another month")
- `contracts/README.md`
- `docs/harness/EXECUTION-SAFETY.md` (now describes the layering)
- DEMO-SCRIPT (bwrap check before recording; the measured run predates the sandbox)
- SUBMISSION-CHECKLIST (diff-safety row, evidence-gate row)
- STATUS

## Verification

| Check | Result |
|---|---|
| Harness unit tests | 115/115, 0 skipped (bwrap 0.11.1) |
| Integration against TrueForge 0.185.1 | 17/17 |
| `scripts/e2e-mock.sh`, default / `--auto-approve-safe-commands --deny-unrestricted` | 21/21 / 21/21; the agent's pytest passes in the sandbox (57 passed) |
| Extension suites / UI e2e | 4/4 / 4/4 |
| `node --test scripts/submission-readiness.test.mjs` | 6/6 |
| `node scripts/check-submission.mjs` | fails as designed (human evidence pending) |
| Contracts typecheck, write-up render, secret scan | clean, 3 pages, clean |

**Not re-measured:** the real-model Task B run that predates the sandbox. A rerun needs authorisation.
