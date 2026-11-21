# Rehearsal log: harness/p14-trueforge-depth

Real-model runs for the finals branch `harness/p14-trueforge-depth` (based on `round1-submission`, 2b265c7).
Every run: profile `nvidia-free` (NVIDIA `nemotron-3-ultra-550b-a55b`, free tier), a fresh TrueForge 0.185.1
database, requests through `scripts/model-meter.mjs`, run by
`node scripts/smoke-real-model.mjs --tasks B --auto-approve-safe-commands --deny-unrestricted --meter-log … --json …`
(the recording settings: safe test commands auto-approved, command budget 3, Unrestricted denied). The pre-flight is
a 1-token request: HTTP 200 before each batch. Records (smoke JSON, smoke log, meter log) are in `rehearsal-p14/`.

Baseline for comparison: the round-1 rehearsal of Task B on `f67c719` (`docs/writeup/rehearsal.json`), with
compaction at 60k, which never fired: 37 requests, 97.8 s, first diff 42 s, 5 reviews, 1,097,214 input tokens.

## Phase 1: compaction at 30k input tokens (2026-11-21, commit 225afeb)

`agent/forge-coder.json` sets `config.context_management.compaction.trigger = {type: "input_tokens", value: 30000}`.
That value comes from the round-1 meter log, where Task B's per-request input passed 30k at about request 17 of 37.
TrueForge emits `thread.context_compaction_started` / `_finished`; the harness turns them into the status lines
"Compacting context: N tokens reached the 30,000-token threshold" and "Context compacted in S s: N tokens summarized
into M", and the panel keeps a "Context compaction" row in the activity list.

Mock test: `src/harness/integration/turn.itest.ts` "compaction: …" (real TrueForge, mock model, 2,000-token
trigger), which checks both status lines, one summary request and a completed edit after it. All offline suites passed on 7b8cc30.

| | B1 (14:12) | B2 (14:28) | round-1 baseline |
|---|---|---|---|
| Checks | 6/6 | 6/6 | 6/6 |
| Compactions | 2: at request 17 (29,972 tokens; 30,471 → 1,090 in 33.5 s) and 49 (29,558; 29,442 → 1,043 in 14.0 s) | 1: at request 19 (30,841; 30,255 → 879 in 19.4 s) | 0 |
| Model requests (incl. summaries) | 63, 0 × 429 | 50, 0 × 429 | 37 |
| Turn time / first diff | 337.2 s / 150.2 s | 254.1 s / 128.9 s | 97.8 s / 42 s |
| Tool calls | 60 (25 read, 13 search, 18 propose_edit, 4 run_command) | 48 (25 read, 9 search, 7 propose_edit, 7 run_command) | — |
| Reviews | 9 (cli.py 6, test_cli.py 2, cli.rst 1) | 6 (cli.py 2, test_cli.py 3, cli.rst 1) | 5 |
| Malformed propose_edit (refused) | 9 | 1 | — |
| Input / output tokens | 1,162,333 / 13,459 | 987,011 / 9,586 | 1,097,214 / 6,090 |
| pytest tests/test_cli.py | 56 passed, 3 skipped | 59 passed, 3 skipped | 57 passed, 3 skipped |

What the runs show:

- **It triggers, and the status lines appear** in both runs, with the token counts and the duration.
- **Each summary is good.** It keeps the user's request word for word, the relevant files, the plan and the pending
  tasks (read from the TrueForge database).
- **It fires before the first edit.** Exploration alone reaches 30k (request 17/19), so the summary throws away the
  file contents just read and the model re-reads them (B1: 11 requests of re-exploration). The first diff moves from
  42 s to 129–150 s, and the turn takes 2.6–3.4× as long. Total input tokens stay about the same, because each request
  after a summary is smaller.
- **B1 hit 60 tool calls**, which equals `iterationLimit` (60); the turn still finished. B1 also had 9 refused
  `propose_edit` calls (edits sent as an invalid JSON string, or no path) and one probe hunk ("Test edit", adding
  `# Test comment` to cli.py) that the smoke accepted (it accepts every hunk). Malformed edits also occur
  without compaction (feature/hybrid-efficiency-native rehearsals: 0–34 per run), so this is model variance, not
  something compaction causes.
- **No 429s, no fallback.** The peak rate stayed under the 40 rpm limit.

Verdict: reliability held (12/12 checks), but speed and request count got worse, and the first diff no longer fits
the video's 105-second slot. Tuning candidate (not yet run on real models): raise the trigger to about 40k so the
single compaction comes after the first edits. In the round-1 log, 40k is reached at about request 33 of 37; B2
would have peaked at about 55k without compaction. A second option is a line in the agent instructions: after a
summary, re-read only the ranges you are about to edit.

## Phase 1b: compaction tuned to 40k (2026-11-21, commit 4f1e269)

Changes:
- **Trigger 40k.** The trigger moved from 30k to 40k input tokens. Across the three B runs on record, the first
  `propose_edit` comes at about 32–36k input (round-1: request 19 at 33.8k). 35k could still fire before it, and
  45k would never fire in a lean run (round-1 peaks at 42k).
- **Instruction after a summary:** re-read only the ranges about to be edited, and don't re-explore files the summary covers.
- **Iteration limit:** `iterationLimit` 60 → 80 (inline unchanged).
- **Smoke run record:** it now places each compaction (model request, before or after the first diff), counts
  `propose_edit` failures as malformed (INVALID_EDIT, INVALID_ARGS, OUTSIDE_WORKSPACE) or refused, and adds a
  WARNING for each accepted hunk whose added lines look unrelated to the task (probe text, or no task term in the
  added lines or the proposal summary). What it accepts is unchanged.

Targets: 6/6; at most 1 compaction, after the first edit; first diff ≤ 60 s; turn ≤ 150 s.

| | B1 (14:46) | B2 (14:59) | B2 redo (15:17) |
|---|---|---|---|
| Checks | **6/6** | 3/6 (429, after edits) | 3/6 (429, after edits) |
| Compactions | 1, request 23, **after** the first edit (39,242 tokens; 38,510 → 851 in 16.6 s) | 0 (ended at ~36k) | 1, request 70, after the first edit (39,718; 39,473 → 1,206 in 20.7 s) |
| First diff | **41.8 s** (request 16) | 125.4 s (request 31) | 258.1 s (request 65) |
| Turn time | 255.4 s | 189.9 s (error) | 383.2 s (error) |
| Model requests | 46, 0 × 429 | 48: 8 × 429, 2 × 502 | 84: NVIDIA 37 (24 × 429), OpenRouter 47 (4 × 429, daily cap) |
| Malformed / refused edits | 0 / 1 (OLD_TEXT_AMBIGUOUS) | 0 / 0 | 6 / 0 |
| Warnings (unrelated hunks) | 0 | 0 | 0 |

- **B1 met three of the four targets.** The turn took 255 s, against the 150 s target. The time went to a failing
  new test. The model fixed it twice, then tried a debug `python -c` (denied as Unrestricted), then three test runs
  that the budget refused. Four requests took 20–28 s each to generate 750–1,400 tokens. After the summary it
  re-read 7 ranges, including the whole of `tests/test_cli.py` and `docs/cli.rst`, which it had not edited yet:
  about 18 s.
- **B2 was spaced 8 min 38 s after B1, not 10 min** (an operator mistake in the wait). NVIDIA returned 429 from
  request 32 on, at about 17–20 requests/min. The last 429 came after edits had been saved, so the turn ended
  with an error (by design: no retry or fallback after a write).
- **B2 redo**, the one 429 redo, after 15 minutes idle and a 1-token check (HTTP 200). NVIDIA throttled from the
  6th request, and the turn fell back to OpenRouter, which then hit its free daily cap. The key had served about
  220 Task B requests in the previous 90 minutes.

Verdict: targets not met, so Phase 2 was not started. Compaction at 40k behaves as intended: once, after the first
edit, with no unrelated hunks. The misses are the turn time (test-fix loop and generation latency in B1) and
NVIDIA's free-tier throttling (B2, redo). The first-diff time also varies with exploration: B2 reached its first
diff at request 31 with no compaction at all.

## Phase 2: test-command budget, Resume after a rate limit, sub-agents (2026-11-21, protocol 0.4.5)

Offline work first (scripted model only), then a paced real batch. Changes:

- **Separate test-command budget.** Test runs (`pytest`, `python -m pytest`, listed: no shell operators; a path or
  `NAME=value` prefix is allowed) count against `TurnRequest.testCommandBudget` (default 3 agent, 1 inline;
  setting `forge.testCommandBudget.*`). `commandBudget` now covers every other command. In phase 1b B1, a denied
  debug `python -c … | head` used the last slot of the shared budget and the next three test runs were refused; now
  the third test run would still run. `command_budget_reached.kind` says which budget refused a call, and the panel
  names it ("test-command budget reached"). The agent instructions are unchanged ("2 run_command calls").
- **Resume after a rate limit.** When a turn stops on a 429 (after TrueForge's own resends, and with no retry or
  fallback left, typically because edits were already saved), the harness emits `resumable` (files changed so far,
  suggested wait 60 s) before the error. The panel shows **Resume** once the wait has passed; it submits the same
  instruction with `resumeOf` in the same session. The harness continues the same TrueForge conversation, puts a
  note before the request ("Resumed turn: … Already changed in that turn: … re-read only the line ranges you are about
  to edit …"), and carries over what the interrupted turn used of both budgets. A turn can be resumed once. Verified
  against TrueForge 0.185.1: a turn that ended in error keeps its tool calls and results in the conversation, so the
  resumed turn sees them. The smoke has `--resume-after-rate-limit` (off; not used in this batch).
- **Sub-agents.** `setup-trueforge.mjs --subagents` enables TrueForge's dynamic sub-agents for `forge-coder` only
  and appends the template's `subAgents.instructions`: at most one read-only exploration sub-agent per task, with a
  self-contained brief, asking for paths, line ranges and verbatim text; edits and commands stay with the main agent.
  TrueForge gives the sub-agent the same MCP tools, so its edits and commands still go through review, the budgets
  and cancellation (approvals carry its thread id). The harness turns `thread.created`/`thread.done` of child threads
  into `subagent` events and status lines ("Delegated to sub-agent "explorer": …", "Sub-agent "explorer" finished"),
  keeps the sub-agent's own text out of the reply, and the smoke records each delegation.

| Offline check | Result |
|---|---|
| Unit (`npm --prefix src/harness test`) | new: test-command classification, split budgets (incl. the B1 sequence), resumable/no resumable, resume note and inherited budgets, a resumed turn rate-limited again, sub-agent events, child-thread approval, child text filtered, failed sub-agent, setup `--subagents` |
| Integration (real TrueForge 0.185.1 + mock model) | new: "resume after a rate limit" (edit saved, 429 until the turn stops, `resumable`, Resume in the same TrueForge session with the earlier tool results in view; bad and repeated `resumeOf` refused) and "sub-agents on the mock" (`create_sub_agent` offered, the sub-agent reads and edits through review, its report returns as the tool result) |
| `scripts/e2e-mock.sh` | new Task R: the scripted model makes Task A's edit, is rate limited until the turn stops, and the smoke resumes it: 24 checks |
| Extension suite | test-budget label, sub-agent rows, Resume offered and resubmitted with `resumeOf` in the same conversation, `testCommandBudget` reaches the harness |

### Phase 2 real batch (2026-11-21, commit 9883169, new NVIDIA key)

All four runs: profile `nvidia-free`, a fresh TrueForge database per pair (README start command, own `SQLITE_PATH`),
requests through the meter with `--min-interval-ms 3000` (at most 20 requests per minute), a 1-token pre-flight
(HTTP 200) before every run, and 15 minutes or more between Task B runs. Records: `rehearsal-p14/phase2-*`.
Recording settings: safe test commands auto-approved, Unrestricted denied, budgets 3 other + 3 test runs.

| | C1 (17:28, compaction 40k) | C2 (17:48, compaction 40k) | S1 (18:09, sub-agents on) | S2 (18:32, sub-agents on) |
|---|---|---|---|---|
| Checks | 3/6 (watchdog, after edits) | **6/6** | **6/6** | 5/6 (its new test fails) |
| Compactions | 1, request 39, after the first edit (39,433 → 783 in 12.8 s) | 1, request 32, after (39,384 → 995 in 20.2 s) | 1, request 34, after (38,554 → 1,121 in 24.7 s) | 1, request 35, after (38,439 → 872 in 29.6 s) |
| Sub-agent delegations | (off) | (off) | 0 | 0 |
| Model requests / 429s | 45+1 (the aborted one is not logged) / 0 | 71 / 0 | 77 / 0 | 43 / 0 |
| Peak requests in 60 s | 19 | 19 | 20 | 19 |
| First diff | 74.6 s (request 21) | 114.1 s (request 26) | 99.7 s (request 23) | 84.4 s (request 23) |
| Turn time | 251.1 s (error) | 334.6 s | 449.4 s | 244.1 s |
| Malformed / refused edits | 0 / 0 | 11 / 1 | 4 / 0 | 2 / 0 |
| Warnings (unrelated hunks) | 0 | 0 | 0 | 0 |
| Test runs / refused by the test budget | 1 / 0 | 3 / 1 | 3 / 1 | 1 / 0 |
| Other commands shown / refused by the budget | 0 / 0 | 3 / 0 | 3 / 4 | 2 / 0 |
| Input tokens | 1,132,054 (meter) | 1,875,325 | 1,927,738 | 1,081,294 |

- **No 429s in 236 requests**: the fresh key plus pacing held. The batch never reached the stop rule.
- **C1 failed on the 45 s silence watchdog, not a rate limit.** The model's `tests/test_cli.py` edit replaced the
  existing `TestRoutes` class (accepted, as the smoke accepts every hunk), its test run failed, and while it was
  generating the repair the harness saw no TrueForge event for 45 s and stopped the turn (no retry or fallback after
  a write). The meter logs a request when it ends, so the aborted one is missing. A long tool-call generation with
  no streamed deltas, or a stalled NVIDIA stream; the records cannot tell which.
- **The separate test budget did its job.** In C2 the third test run came after a debug `python -c` and passed; under
  the old shared budget of 3 it would have been refused. In S1 the final, passing test run came after four other
  commands had been refused by their own budget. `pytest … | head` counts as another (Unrestricted) command.
- **Sub-agents were offered but never used** (S1, S2: one thread each; the agent manifest has
  `dynamic_sub_agents.enabled` and the guidance; the integration test shows TrueForge offers `create_sub_agent` with
  this configuration). Nemotron chose not to delegate, so this batch measures nothing about delegation; S1 and S2 are
  effectively two more compaction-40k runs. S2 ran its new test once, got a failure, tried `cd /workspace && pytest`
  twice (Unrestricted, denied), and ended claiming success.
- **Compaction at 40k**: once per run, always after the first edit (4/4).
