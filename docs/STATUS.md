# Project status

Updated: 2026-11-19 (late night), after merging `origin/main` (PRs #3 and #4 by another contributor:
bubblewrap command protection, hold-until-idle for unsettled tools, retrieval coverage reporting, submission
evidence gate). See "Merge of origin/main" and `docs/review/merge-origin-main.md`. All automated checks are
green on the mock. The real-model runs below **predate the sandbox**. Readiness is tracked by
`node scripts/check-submission.mjs` (fails until the human evidence is filled in; `docs/harness/CONTEXT-READINESS.md`).

Before that: the real-model validation of the guardrails. **Harness-enforced command
budget, narrowed auto-approval and an argument-shape hint for repeated bad edits** are on main and **validated
with the real models**: Task B with the video settings passed 6/6 with 3 commands (4 more refused by the
budget) and `cli.py` in 3 reviews, which meets the targets, so no further fix or run was needed. A and C also
passed (see "Real-model validation of the guardrails"). The README was reconciled with the submission spec.
Earlier: the first
real-model run and a Task B tuning round (free tiers only, $0). **Tasks A, B and C passed with real models**,
but the Task B tuning target (≤ 3 command approvals, 1 review per file) was **not** met. Earlier the same day: the independent review
(`~/forge-review/CODEX-REVIEW.md`), triaged in `docs/review/codex-review-triage.md`; blockers B2-B4 and issues
I1-I10 are fixed and merged. Remaining human steps are at the end of this file (manual test, push, video, PDF,
form).

## MVP checklist

Legend: ✅ verified (how) · 🟡 needs a human step · ❌ missing

"UI e2e" = `scripts/test-extension-e2e.sh`: a real VS Code 1.146 window (WSLg) runs the extension's Workbench
against TrueForge 0.185.1 + the scripted demo model on a copy of Flask 3.1.3.
"Harness e2e" = `scripts/e2e-mock.sh`: the same tasks through `createHarness` without a GUI, plus the Flask
verification commands. "Real run" = `scripts/smoke-real-model.mjs` (same checks) with the real models below.

| Item | Status | Evidence |
|---|---|---|
| Task A: inline edit → diff → accept → saved | ✅ | UI e2e + harness e2e (`FLASK_DEBUG=off` → False, `N` → False, `1` → True) |
| Task A: per-hunk review | ✅ | Extension suites in a real VS Code window (partial approval, all six apply outcomes asserted) |
| Task A: undo | ✅ | UI e2e (undo restores the file; `git status` clean); extension suite with a formatting save participant (exact bytes restored) |
| Task A: keybinding, input box, notifications | 🟡 | Contributed; only checkable by hand → `docs/MANUAL-TEST.md` |
| Task B: panel streaming + tool calls (incl. deferred `find_symbol` via `call_tool`) | ✅ | UI e2e + harness e2e |
| Task B: context block (used/budget, reasons, skipped) | ✅ | UI e2e; `src/flask/cli.py` ranks #1 (Flask ranking regression test) |
| Task B: ≥3 files, per-file review, verification | ✅ | Exactly `cli.py`, `test_cli.py`, `docs/cli.rst`; `pytest tests/test_cli.py -q` 57 passed; `flask --help` lists `config`; masked JSON |
| Task C: invalid primary → fallback, workspace unchanged | ✅ | UI e2e (panel banner, `git status` clean) + harness e2e; fallback also shown as a VS Code notification |
| Cancel: Stop ends the turn, review closes, no partial edits | ✅ | UI e2e + harness integration (cancel while paused / streaming / racing an apply) + unit races (Stop before a command spawns; silent TrueForge ends the turn once, bounded) |
| TrueForge session link | ✅ | UI e2e (link present); opening it is manual |
| Demo without keys | ✅ | `scripts/dev-mock.sh` |
| Real model (Tasks A, B, C) | ✅ | Real runs 2026-11-19: A 6/6 (twice), C 3/3, B 6/6 (three times) (see "Real-model run", "Task B tuning round") |
| Optional auto-approval (`forge.autoApproveSafeCommands`, default off), narrowed to bare `pytest`, `python -m pytest`, `git status`, `git diff` | ✅ | Harness unit tests (these auto-approved and run; `python -c`, `flask`, path/env-prefixed pytest, pipes, `cd`, edits always ask; off unless `true`); extension suite; `e2e-mock.sh --auto-approve-safe-commands` 20/20 (Task G: `git status`/`git diff` auto-approved, `python -c` asked) |
| Command budget per turn (`forge.commandBudget.agent` 3, `.inline` 1), enforced by the harness | ✅ | Unit tests (4th and 5th command refused without a prompt with the exact message; denied, unrestricted and auto-approved commands count; 0 refuses all, edits unaffected; defaults); extension suite ("command budget reached" in the panel, settings reach the harness); `e2e-mock.sh` Task G (3 shown, 2 refused, refusal reached the model). Not yet measured with a real model |
| Guardrails with the real models (video settings) | ✅ | Real run 4 (2026-11-19): Task B 6/6, 3 commands shown (1 auto-approved, 2 asked), 4 refused by the budget, 6 reviews; A 6/6, C 3/3 (see "Real-model validation of the guardrails") |
| Repeated argument errors on one file → refusal includes the exact `propose_edit` shape | ✅ | Unit tests (2nd refusal for the same file has it, other files and content errors do not; the example is valid JSON); `e2e-mock.sh` Task G (the model received one hint) |

## Real-model run (2026-11-19)

Models (all free tiers, $0; `config/models.json`, default of `config/models.example.json`):

| Role | TrueForge model | Provider model id | Why |
|---|---|---|---|
| Primary | `nvidia/nemotron-3-ultra` | `nvidia/nemotron-3-ultra-550b-a55b` (NVIDIA API Catalog) | The catalog listed no Qwen3 Coder, Qwen3.x or DeepSeek. Probes (one request each): Kimi K3.1 Pro correct but 95 s/request; GLM-5.3 Flash and Step-5 timed out; Mistral Large 4, MiniMax M3.1 Flash and Nemotron-3 Ultra made correct tool calls, Nemotron fastest (0.9 s / 7 s) and the only one with a fully correct streamed `propose_edit` |
| Fallback | `groq/qwen3-8-27b` | `qwen/qwen3.8-27b` (Groq) | Proposed the correct edit directly (gpt-oss-120b re-read the file); clean content (no `<think>`); same free limits (1000 req/day, 8000 tokens/min) |
| Spare, unused | `openrouter/nemotron-3-ultra-free` | `nvidia/nemotron-3-ultra-550b-a55b:free` (OpenRouter) | `qwen/qwen3-coder:free` is not listed; this free model made correct tool calls (1 probe) |

Tool-calling probe through TrueForge (throwaway agent calling the `get_current_datetime` system tool): NVIDIA 2
requests, 6.2 s; Groq 2 requests, 0.7 s; both `done`. Then a fresh TrueForge 0.185.1 database
(`~/forge-data/real-20261119-104034.sqlite`), setup, and each task once through `scripts/model-meter.mjs`:

| Task | Result | Model | Requests | 429s | Tokens in / out | Time | Notes |
|---|---|---|---|---|---|---|---|
| A | ✅ 6/6 | nemotron-3-ultra | 3 | 0 | 11,441 / 635 | 8.5 s | `read_file` + one `propose_edit`; docstring lists all five values. Cosmetic: the added blank docstring line has trailing spaces |
| C | ✅ 3/3 | nemotron-3-ultra → qwen3.8-27b | 3 (1 × 401 NVIDIA, 2 Groq) | 0 | 6,848 / 403 | 2.6 s | NVIDIA's invalid key: `[Model Error] Request failed (401): Unauthorized` in 0.19 s, recognised as auth → fallback at once; proposal rejected; `git status` clean; key restored |
| B | ✅ 6/6 (first attempt) | nemotron-3-ultra | 49 | 0 | 1,616,316 / 7,503 | 133 s | 48 tool calls (21 `read_file`, 5 searches, 7 `propose_edit`, 15 `run_command`); 4 files (`cli.py`, `test_cli.py`, `docs/cli.rst`, `docs/api.rst`), 7 reviews; 57 passed |

Totals of the three tasks: 55 model requests (53 NVIDIA incl. the one 401, 2 Groq), 1.63M input / 8.5k output
tokens, no 429s and no TrueForge-internal retries (meter and TrueForge log agree; token sums match TrueForge's
metrics). Outside the tasks: 13 NVIDIA chat requests for probes (+ 1 unauthenticated invalid-key check), 9 Groq
(2 of them blocked by Cloudflare's client check before reaching the API), 1 OpenRouter, and one model-list call
per provider.

**Failures and causes.** No task failed. Observations from Task B (model behaviour, not harness faults):
- It over-verified: 15 commands (each needs approval in the editor), including `make html` (Sphinx not
  installed) and full-suite runs; two used `… | tail -20`, which hides pytest's exit code.
- One command was `cd /workspace && …` (a guessed path); it failed harmlessly and the model retried without it.
  Fixed generally: the `run_command` description now says commands start in the workspace root and to use
  relative paths (mock-tested only).
- It split `cli.py` into 3 reviews and `test_cli.py` into 2 although the instructions say one call per file.
- Token use comes from 49 steps that each resend the growing conversation (largest tool result 6.5k chars;
  compaction at 60k tokens was not reached).
- Tightening the verification instructions: done in the tuning round below.

## Guardrails round (2026-11-19, branches harness/p11-command-budget, docs/readme-final)

Decided after the tuning round: build the budget in the harness, narrow auto-approval, add the argument hint,
no real-model runs today (mock only). Protocol 0.4.4: `TurnRequest.commandBudget`, event
`command_budget_reached`.

- **Command budget:** every `run_command` the turn presents (prompted or auto-approved) counts; once the budget
  is used, further calls are denied to the model with "command budget for this turn exhausted; stop running
  commands, finish edits and summarize" (TrueForge prefixes "User denied tool call:"), without a prompt, and the
  panel lists "command budget reached (N per turn): <command>". Edits are never limited.
- **Auto-approval narrowed** to bare `pytest`, `python -m pytest` (python, python3, python3.N), `git status`,
  `git diff`, with no shell operators, no `NAME=value` prefix and no path before the program (a path could name
  any workspace script). `python -c` and `flask` stay listed (no ⚠) but always ask.
- **Argument-shape hint:** a `propose_edit` refused for an argument error (`INVALID_ARGS`, `INVALID_EDIT`,
  `OUTSIDE_WORKSPACE`) on a file that already had one in the turn gets the exact shape with a minimal example.
  Content errors (`OLD_TEXT_NOT_FOUND`, `STALE_BASE`, …) do not.
- **Mock e2e Task G** (`scripts/e2e-mock.sh`): the scripted model sends a malformed edit twice, then 5 commands;
  checks 3 shown / 2 refused, the auto-approval split, the hint and the refusals reaching the model, no file
  changed. The agent instructions are unchanged (still "2 run_command calls"), so tomorrow's run measures the
  harness changes alone.

| Check | Result |
|---|---|
| `npm --prefix src/harness test` | 98/98 (new: budget ×4, narrowed auto-approval ×2, argument hint ×2) |
| `npm --prefix src/harness run test:integration` (fresh TrueForge 0.185.1) | 17/17 |
| `scripts/e2e-mock.sh` / `--auto-approve-safe-commands --deny-unrestricted` | 21/21 / 21/21 (new Task G, 6 checks; its `ls src` is ⚠ Unrestricted and is denied with the second flag) |
| `scripts/test-extension.sh` | 4/4 (new: "command budget reached" panel state; `commandBudget` defaults 3/1 and reaches the harness) |
| `scripts/test-extension-e2e.sh` | 4/4 |
| `tsc -p contracts`, extension compile | clean (protocol 0.4.4) |
| `scripts/render-writeup.sh` | 3 pages |
| Fresh clone of `docs/readme-final` (README at `1d25966`), mock only, README commands as written | ✅ in 132 s with warm npm caches: build; Flask 3.1.3 workspace (quickstart step 8); `cp config/models.example.json` + `setup-trueforge.mjs --dry-run` (NVIDIA, Groq, OpenRouter, 4 agents on nemotron / qwen3.8); `e2e-mock.sh` 21/21 and 21/21 with `--auto-approve-safe-commands --deny-unrestricted`; 98/98 unit; 17/17 integration; `test-extension-e2e.sh` 4/4 (stands in for F5). Clone in `/tmp/forge-readme-*` |

## Merge of origin/main (2026-11-19, late night, branch integrate/origin-main)

Merged `origin/main` (`fe72740`) with `git merge` (no rebase, no force-push). Decisions taken with the user:

- **Both layers for `run_command`:** origin's bubblewrap protection and fail-closed behaviour, plus our
  approval, ⚠ Unrestricted label, command budget, auto-approval and change report.
- **Hold until idle for unsettled tools:** origin's behaviour.

Every resolution is listed in `docs/review/merge-origin-main.md`.

| Check (on the merge) | Result |
|---|---|
| `npm --prefix src/harness test` | 115/115, none skipped (bwrap 0.11.1 present); new from origin: sandbox ×7, settlement ×3, context coverage ×5; new in the merge: venv under /tmp visible, outside-review backstop |
| `npm --prefix src/harness run test:integration` | 17/17 (the compound command is flagged unrestricted and now fails read-only) |
| `scripts/e2e-mock.sh` / `--auto-approve-safe-commands --deny-unrestricted` | 21/21 / 21/21; the agent's own `pytest` passes inside the sandbox (57 passed) |
| `scripts/test-extension.sh` / `scripts/test-extension-e2e.sh` | 4/4 / 4/4 |
| `node --test scripts/submission-readiness.test.mjs` | 6/6 |
| `node scripts/check-submission.mjs` | fails as designed: write-up placeholders (team, URLs, `[mm:ss]`) and no `docs/writeup/rehearsal.json` yet |
| `tsc -p contracts`, `scripts/render-writeup.sh`, secret scan | clean, 3 pages, clean |

## Real-model validation of the guardrails (2026-11-19, night)

Authorised: Task B with the video settings, then A and C once; the 250/day cap was lifted (the NVIDIA account
shows only "up to 40 rpm"). The run used a fresh TrueForge 0.185.1 database
(`~/forge-data/real-20261119-120037.sqlite`), the latest main harness, unchanged agent instructions, and
requests counted by `scripts/model-meter.mjs`.

| Run | Checks | Command prompts / auto-approved / denied / budget refusals | Reviews per file | Requests (peak/min) | 429s | Tokens in / out | Time |
|---|---|---|---|---|---|---|---|
| B #4 (`--auto-approve-safe-commands --deny-unrestricted`) | ✅ 6/6 | 2 / 1 / 0 / 4 | `cli.py` 3, `test_cli.py` 2, `cli.rst` 1 | 47 NVIDIA (28) | 0 | 1,442,113 / 9,337 | 204.5 s (first diff ≈ 53 s) |
| A | ✅ 6/6 | 0 / 0 / 0 / 0 | `helpers.py` 1 | 3 NVIDIA (3) | 0 | 11,031 / 639 | 9.4 s |
| C | ✅ 3/3 | 0 / 0 / 0 / 0 | `helpers.py` 1 (rejected) | 1 NVIDIA 401 + 2 Groq | 0 | 6,853 / 406 | 2.3 s |

Targets: ≤ 3 commands, ideally 1 review per file, at most about 3–4 for `cli.py`. **Met**, so there was no
fix and no second run (one of the three authorised Task B runs was used).

- **Commands:**
  - `python -m pytest tests/test_cli.py::TestConfig -v` was auto-approved.
  - Two `python -c` checks were asked and allowed. None were ⚠ Unrestricted this run.
  - Four more commands were refused by the budget; the model then stopped running commands and summarised.
- **Edits:**
  - `cli.py` still came as 3 proposals: the import, the function, the registration.
  - `test_cli.py` came as 2: the tests, then a fix after the model's own test failed.
- **Refusals the model recovered from:**
  - One `OLD_TEXT_NOT_FOUND`.
  - One `edits` string that was not valid JSON (refused once, so the shape hint was not needed).

## Task B tuning round (2026-11-19, branch harness/p10-task-b-tuning)

Goal: ≤ 3 command approvals, 1 review per file, all 6 checks. Two real Task B runs (setting off) and one Task A
regression run on a fresh database (`~/forge-data/real-20261119-112419.sqlite`), counted by the meter:

| Run | Instructions | Checks | Command approvals | Reviews per file | Requests | 429s | Tokens in / out | Time |
|---|---|---|---|---|---|---|---|---|
| B #2 | 1st tuning (one proposal per file, ≤ 2 targeted commands, no pipes/cd, install nothing) | ✅ 6/6 | 17 (5 Unrestricted) | `cli.py` 7, `test_cli.py` 4, `cli.rst` 1 | 61 | 0 | 2,191,142 / 18,571 | 259 s |
| B #3 | 2nd tuning (explore / edit / verify phases, explicit 2-command budget, tests follow the request literally) | ✅ 6/6 | 7 (4 Unrestricted) | `cli.py` 8, `test_cli.py` 2, `cli.rst` 1 | 71 | 0 | 2,499,943 / 13,896 | 240 s |
| A | unchanged (inline agent) | ✅ 6/6 | 0 | `helpers.py` 1 | 3 | 0 | 11,208 / 635 | 11.4 s |

Causes:
- **B #2:** the model wrote a test that narrowed the request (expected a key containing "KEY" to stay unmasked),
  then looped fix → test five times, ignoring the 2-command limit; after the tests passed it added `--help`
  checks and ad-hoc scripts (`cd /tmp …`). Its first `cli.py` change (function, then registration) came as two
  proposals.
- **B #3:** the instructions helped with commands (7 vs 17) but the model sent `propose_edit` with `edits` as a
  **JSON-encoded string** in 12 calls; the harness refused them as "edits must be a non-empty array", and the
  model probed with tiny edits ("Test edit", "Add comment") and switched to `call_tool`, producing 8 `cli.py`
  reviews. **Fixed in the harness** (general, tested on the mock): a string that parses to an array is
  accepted everywhere the arguments are read; an unparseable one gets an error saying to pass the array. Not
  re-measured with a real Task B run: the two authorised runs were used and a third would exceed today's NVIDIA
  cap (203 of 250 used).
- After its 2 test runs, B #3 still ran 5 more commands (4 Unrestricted: `cd …`, a here-doc, `python -m flask`),
  so instructions alone do not enforce the budget with this model. Decided afterwards: a harness-enforced
  command budget, narrowed auto-approval ON for the video and Deny on ⚠ Unrestricted (see "Guardrails round").

Model requests today: NVIDIA 254 (13 direct probes; 2 TrueForge probe + 53 tasks in the first real run; 61 + 71 + 3
in the tuning round; 47 + 3 + 1 in the guardrails validation); Groq 15 (9 direct probes, 2 TrueForge probe, 2 + 2 in
Task C); OpenRouter 1 (probe). No 429s; peak 28 requests/min (Task B #4), under NVIDIA's 40 rpm.

### Verification after the tuning round (harness/p10-task-b-tuning, 2026-11-19)

| Check | Result |
|---|---|
| `npm --prefix src/harness test` | 90/90 (new: auto-approval policy ×3, `edits` as a JSON string in review / MCP / turn, `normalizeEdits`) |
| `npm --prefix src/harness run test:integration` (fresh TrueForge 0.185.1) | 17/17 |
| `scripts/e2e-mock.sh` / `--auto-approve-safe-commands` | 15/15 / 15/15 (Task B's pytest shown as auto-approved) |
| `scripts/test-extension.sh` | 4/4 (new: auto-approved command opens no prompt, panel line, unrestricted still asks, off by default) |
| `scripts/test-extension-e2e.sh` | 4/4 |
| `tsc -p contracts`, extension compile | clean (protocol 0.4.3) |
| `scripts/render-writeup.sh` | 3 pages |

### Verification after the real-model fixes (harness/p7-real-model, 2026-11-19)

| Check | Result |
|---|---|
| `npm --prefix src/harness test` | 83/83 (new: model meter, NVIDIA 401 text, `run_command` description) |
| `npm --prefix src/harness run test:integration` (fresh TrueForge 0.185.1) | 17/17 |
| `scripts/e2e-mock.sh` | 15/15 |
| Metered mock run (demo model → `model-meter` → TrueForge; `smoke-real-model.mjs --meter-log`, Tasks A, B, C) | 15/15; requests per task A 2, B 10, C 3 (1 × 401) |
| `scripts/test-extension-e2e.sh` | 4/4 |
| `scripts/render-writeup.sh` | 3 pages; fixed: it hung when stdin was not a terminal (md-to-pdf then reads stdin) |

### Final verification on main after the review fixes (2026-11-19)

| Check | Result |
|---|---|
| `npm --prefix src/harness test` | 78/78 (incl. 9 turn races against an in-memory TrueForge stand-in, regex deadline, ignore policy, run_command races) |
| `npm --prefix src/harness run test:integration` (fresh TrueForge 0.185.1) | 17/17 |
| `scripts/test-extension.sh` (extension suites in VS Code) | 4/4 |
| `scripts/e2e-mock.sh` | 15/15 checks (docstring check now asserts every false value) |
| `scripts/test-extension-e2e.sh` | 4/4 (Task A, Task B, Stop, Task C) |
| `tsc -p contracts`, extension compile | clean (protocol 0.4.2) |
| Fresh clone (temp dir) following the README | builds; 78/78 unit; setup dry run; `e2e-mock.sh` 15/15 and `test-extension-e2e.sh` 4/4 from the clone |
| Write-up PDF (`scripts/render-writeup.sh`, now fails outside 1–3 pages) | 3 pages |
| Secret scan | done before the review fixes (120 commits, nothing found); the fixes add no keys (test values are fake) |

All automated checks use the scripted demo model: they prove the plumbing, not real-model task success.

## Review fixes (merged into main)

| Branch | Fixes |
|---|---|
| contracts/v0.4.2 | `command_request.unrestricted` / `warning`; protocol 0.4.2 |
| harness/p8-review-fixes | B2 command never starts after Stop; B4 cwd real-path check, scrubbed env, unrestricted label, "changed outside review"; B3 no retry/fallback while an approved write is unfinished, old gate closed; bounded cancel and silent streams, watchdog waits for running tools; auth errors by wording, fallback on other provider errors; key redaction; regex in a worker with a 2 s deadline; one ignore policy (nested `.gitignore`, negations, default excludes, credentials files); listing truncation reported; stricter smoke checks; render page limit |
| editor/e6-review-fixes | undo restores exact bytes (save without participants) and verifies; post-save hash for new files; unrestricted warning in panel and quick pick; cancelled review closes its diff; listing cap 20000 |
| docs/review-fixes, docs/review-status | triage, README `run_command` section and shared install, write-up limitations, demo script (real models only, session shot), this file, checklist |

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

## Final rehearsal (2026-11-19, `main` at `e5afea6`)

Real models, video settings, fresh TrueForge database, requests paced at ≥ 1.6 s per provider through
`scripts/model-meter.mjs --min-interval-ms 1600`; run A, then C, then B (`docs/writeup/rehearsal.json`).

| Task | Result | First diff | Turn | Requests | Tokens in / out |
|---|---|---|---|---|---|
| A | 6/6 passed | 7.8 s | 9.1 s | 3 NVIDIA | 11,274 / 675 |
| C | 3/3 passed (NVIDIA 401 → Groq) | 2.0 s | 2.5 s | 1 NVIDIA (401) + 2 Groq | 6,835 / 393 |
| B, attempt 1 | not passed: 429 after three saved `cli.py` edits (no retry or fallback by policy) | 68.0 s | 127.7 s | 30 NVIDIA (2 × 429) | 627,824 / 4,171 (meter) |
| B, attempt 2 (after 5 min) | not passed: 429s before any edit → one retry → Groq fallback → 413 (7,000 input tokens/min) | — | 32.4 s | 15 NVIDIA (6 × 429) + 1 Groq | — |

NVIDIA's 429s came at 9–15 requests in the preceding minute, without `Retry-After`: the account was throttled
below the documented 40/min after the day's use. Groq's free tier cannot run Task B as the fallback. A passing
real Task B on the sandboxed build exists from QA's run on `37fb675` (first diff 105.5 s, turn 160.3 s).

## Branch map

The repository is public. `origin/main` is `37fb675` (history without commit trailers); later work on `main`
is a fast-forward from it. All branches below are merged into `main` with `--no-ff`.

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
| integrate/origin-main | merge of origin/main (PRs #3, #4): bubblewrap protection, hold-until-idle, coverage reporting, submission evidence gate; resolutions in `docs/review/merge-origin-main.md` |
| harness/p11-command-budget | command budget (protocol 0.4.4), narrowed auto-approval, argument-shape hint, mock e2e Task G, editor settings and panel line |
| docs/readme-final | README reconciled with the submission spec (real models first, eligibility table, Mermaid architecture, beginner key steps, tasks, safety model, troubleshooting, mock mode last), `docs/images/README.md`, mock Task G with an ⚠ Unrestricted command, write-up, demo script with measured numbers, checklist, this file |
| harness/p10-task-b-tuning | forge-coder instructions (two rounds), `forge.autoApproveSafeCommands` (protocol 0.4.3), `edits`-as-string fix, approvals per task in the smoke run, demo script timings |
| harness/p7-real-model | real-model setup (NVIDIA primary, Groq fallback, OpenRouter spare), `scripts/model-meter.mjs`, `--meter-log`, `run_command` description, NVIDIA 401 regression test, docs |
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
12. Real models, free tiers only: NVIDIA `nemotron-3-ultra-550b-a55b` primary, Groq `qwen3.8-27b` fallback, OpenRouter
    `nemotron-3-ultra-550b-a55b:free` spare (reasons in "Real-model run"). No `reasoningEfforts` configured for them
    (TrueForge only warns), so no reasoning parameter is sent to the providers.
13. Requests and 429s are counted by a loopback metering proxy (`scripts/model-meter.mjs`), because TrueForge's
    internal HTTP retries are invisible to the harness. It records no bodies, headers or keys.
14. Auto-approval of listed commands lives in the harness (it owns the list), opt-in per turn from the editor setting;
    protocol 0.4.3. `python -c` is on the list, so auto-approval can run arbitrary Python: documented, default off.
15. Model quirks are handled in the harness when general (JSON-string `edits`), not with model-specific prompts.
16. The command budget is enforced in the harness, not the prompt: every presented command counts (asked, denied or
    auto-approved), so auto-approval cannot exceed it; default 3 for the agent, 1 inline (two settings,
    `forge.commandBudget.agent` / `.inline`, because the defaults differ by mode).
17. Auto-approval no longer covers `python -c` and `flask` (both run arbitrary code); they keep the "listed" label
    (no ⚠) but always ask. Supersedes the `python -c` caveat of decision 14.
18. The argument-shape hint is added from the second argument-error refusal on the same file in a turn (the first
    refusal stays short); keyed by the path string the model sent.
19. `run_command` runs in bubblewrap (origin) in addition to our approval layers; fail closed without it (decided with
    the user during the merge). A virtualenv outside the workspace is bound read-only so it stays visible.
20. An unsettled tool holds the session until it finishes (origin), instead of our bounded settle-then-end.
21. Retrieval keeps our shared ignore policy and 20,000-file listing; origin's coverage reporting and fail-closed
    unreadable `.gitignore` are ported onto it.

## Known issues and risks

- **Real models checked in a few runs.** Task B varies a lot between runs with this model (49–71 requests,
  133–259 s, 7–17 command approvals, 7–12 reviews before the command budget; with it: 47 requests, 204.5 s, 3
  commands, 6 reviews). The budget caps commands but not reviews: the model still splits `cli.py` into about 3
  proposals despite its instructions. NVIDIA's free tier is ≈ 40 requests/min account-wide: Task B peaked well below that, but two Task B
  runs back to back could approach it (429s wait for `Retry-After`, then one retry, then fallback to Groq, whose
  8000 tokens/min limit is small for Task B's ≈ 33k-token requests).
- Compaction is configured but never triggered by the demo tasks.
- A fallback starts a new TrueForge session (no earlier panel history).
- `run_command` runs in bubblewrap (read-only checkout and host, private /tmp, no network, no keys) on top of
  approval, the ⚠ label and the budget; it needs Linux/WSL with bubblewrap (otherwise commands are refused). Reads are
  not restricted (not a confidentiality boundary). The real-model Task B numbers were measured before the sandbox.
- An unsettled tool now holds the session until it ends (bounded by the command timeout, at most 600 s, or Stop).
- Fallback on an invalid key is matched by status code and wording; verified with NVIDIA (401 "Unauthorized") and
  the demo model. Other providers' wordings are covered by tests only.
- Not fixed from the review: event/receipt retention for the editor's lifetime and cached model names after rerunning
  setup while the editor runs (restart the Extension Development Host after setup).
- Hunk review uses a picker, not per-hunk CodeLens.
- Scratch data from today: `~/forge-dev` (test databases, logs), `~/.forge-mock` (demo-mode databases),
  `/tmp/forge-readme-*` (walkthrough clones), `~/forge-backup-untracked-extension-20261118-191829` (old untracked
  copy from last night) — all safe to delete. `~/.cache/forge-vscode` and `~/.cache/forge-vscode-libs` are reused by the tests.

## Needs human — steps for 20 Nov, in order

1. ~~Choose models + export keys~~ — done (`config/models.json`; keys from `~/.forge-keys.env`).
2. ~~Setup + one real-model rehearsal~~ — done 2026-11-19, A/B/C green (see "Real-model run"). For the video:
   start TrueForge (README step 2) on a fresh database, `source ~/.forge-keys.env`, `node scripts/setup-trueforge.mjs`.
   Video settings decided: `forge.autoApproveSafeCommands` on (narrowed list), budget 3, Deny ⚠ Unrestricted
   (see `docs/DEMO-SCRIPT.md`, "Task B: what to expect").
   ~~Real Task B validation with those settings~~: done 2026-11-19 night (6/6; numbers in DEMO-SCRIPT), but
   **before** the sandbox merge: one real Task B rerun with bubblewrap is recommended (needs your authorisation).
   Check `bwrap --unshare-all --ro-bind / / --proc /proc --dev /dev -- true` before recording.
3. **Manual VS Code checklist:** `docs/MANUAL-TEST.md` (≈ 20 min).
4. **Push:**
   ```bash
   cd ~/projects/forgeathon && git push origin main      # a fast-forward from origin/main
   ```
   The repository is public; confirm the new commits show up signed out.
5. **Record** per `docs/DEMO-SCRIPT.md` (≤ 4:00; Tasks A, B, C in order; no cut between instruction and diff).
6. **Evidence gate:** copy `config/rehearsal.example.json` to `docs/writeup/rehearsal.json`, fill in the real
   A/B/C runs (session URLs, tokens, video timestamps), and run `node scripts/check-submission.mjs` until it passes.
6b. **Write-up:** fill team, Team ID, repo/video URLs, final models + cost, `[mm:ss]` timestamps and the
   real-model limitation line in `docs/writeup/WRITEUP.md`; `scripts/render-writeup.sh` (must say 1–3 pages).
   Commit the text changes, push.
7. **Submit** https://forms.gle/htyWGFJRBgsg3qmx6 (repo link, PDF, video link, Team ID); check every link signed out.
