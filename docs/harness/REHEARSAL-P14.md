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
