# Demo video script (target ≤ 3:55, hard limit 4:00)

Rules from the problem statement: Tasks **A, B, C in this order**; show every verification; briefly show the
TrueForge session for Task B; model waiting time may be cut, but **never cut between giving an instruction
and the diff appearing**. The video must be publicly viewable: after uploading, open the link in a private
browser window (signed out) to confirm.

## Before recording (resets)

```bash
# 1. Fresh Flask workspace at the pinned commit (venv excluded from git status)
cd ~ && mv flask-demo flask-demo.old-$(date +%s) 2>/dev/null; git clone -q https://github.com/pallets/flask flask-demo
cd ~/flask-demo && git checkout -q 22d92470 && python3 -m venv .venv && echo ".venv/" >> .git/info/exclude
.venv/bin/pip install -q -e . "pytest==9.0.2" && git status --short    # must print nothing

# 2. Fresh TrueForge database + setup (real models)
cd ~/projects/forgeathon && source ~/.forge-keys.env     # NVIDIA_API_KEY, OPENROUTER_API_KEY (never shown on screen)
OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","integrate.api.nvidia.com","openrouter.ai","api.groq.com"]' \
  MODEL_HTTP_CONNECT_TIMEOUT_MS=3000 MODEL_HTTP_MAX_RETRIES=4 \
  SQLITE_PATH=$HOME/forge-demo-$(date +%Y%m%d-%H%M).sqlite npx -y @truefoundry/trueforge@0.185.1   # terminal 1
scripts/use-models.sh nvidia-free                                                                 # terminal 2

# 2b. Pre-flight: ONE tiny request to the primary model (max_tokens 1). Exit 0 = ready.
node scripts/preflight-model.mjs
#   "RATE LIMITED (HTTP 429 …)" → NVIDIA is throttling: switch and check again (no code change):
#     scripts/use-models.sh openrouter-free && node scripts/preflight-model.mjs
#   Only if you have added OpenRouter credit: scripts/use-models.sh openrouter-paid --paid-ok

# 3. Command protection: approved commands run in bubblewrap (read-only checkout, no network). Must succeed:
bwrap --unshare-all --ro-bind / / --proc /proc --dev /dev -- true && echo protection-ok
```

4. VS Code: **WSL: Connect to WSL** → open `~/projects/forgeathon/extension` → **F5** → in the Extension
   Development Host open `~/flask-demo`. Do one throw-away inline edit to warm up, then
   `git -C ~/flask-demo checkout -- .`
5. Layout: editor left, Forge agent panel right (Forge-a-thon: Open Agent Panel), integrated terminal
   bottom (cwd `~/flask-demo`). Browser tab with http://localhost:8790 → Sessions, ready.
6. Readability: `"editor.fontSize": 16`, `"terminal.integrated.fontSize": 15`, `"window.zoomLevel": 1`,
   minimap off, close unrelated panels, OS notifications off. The review prompt (Accept All / Reject All / Choose Hunks...) is a
   quick pick at the top of the window and closes when the review is decided or the turn is stopped.
   1920×1080 recording.
7. Have the three instructions in a text file to paste (exact wording below).
8. Settings in the Extension Development Host for the recording:
   - `"forge.autoApproveSafeCommands": true`. This auto-approves only `pytest`, `python -m pytest`,
     `git status` and `git diff`.
   - `forge.commandBudget.agent` at its default of `3`.
   - Every diff is still reviewed. `python -c`, `flask` and ⚠ Unrestricted commands still ask.

## Task B: what to expect

Models (profile `nvidia-free`): NVIDIA `nemotron-3-ultra-550b-a55b` (primary), the same model on OpenRouter's free
tier (`nvidia/nemotron-3-ultra-550b-a55b:free`, fallback). Groq `qwen3.8-27b` is a configured spare; it was used as the
fallback in earlier rehearsals, before OpenRouter replaced it (its free tier cannot take Task B).

**TrueForge's rate-limit cushion:** the start command's `MODEL_HTTP_MAX_RETRIES=4` makes TrueForge resend a 429'd
model request up to 4 times (waits 1, 2, 4, 8 s when there is no `Retry-After`) before the turn sees an error.
The wait is invisible on screen except as a pause, and it happens after the first diff or before it; never cut it
before the first diff.

**Context compaction (finals branch `harness/p14-trueforge-depth`):** agent mode compacts at 30k input tokens,
and in Task B this happens once or twice. On screen, the panel status line shows "Compacting context: 30,841 tokens
reached the 30,000-token threshold" and then "Context compacted in 19.4 s: 30,255 tokens summarized into 879", and
the activity list keeps a **Context compaction** row. Show it; it is TrueForge feature evidence. Timing impact:
it fires before the first edit, so in the two real runs (`docs/harness/REHEARSAL-P14.md`) the first diff came after
129 s and 150 s. That is over the 105 s uncut slot (0:55–2:40), so the B slot needs re-timing on this branch, or a
higher threshold, before any recording.

**Measured on the current code** (QA run on `37fb675`, 2026-11-19, with bubblewrap protection and the
recording settings: auto-approval on, budget 3):

| | Task A | Task B | Task C |
|---|---|---|---|
| Instruction → first diff (uncut on video) | 11.2 s | **105.5 s** | 29.5 s (2.3–2.6 s in earlier runs) |
| Whole turn | 14.2 s | 160.3 s | 35.0 s |
| Reviews | 1 | 5: `cli.py` 2, `tests/test_cli.py` 2, `docs/cli.rst` 1 | 1 (rejected) |
| Commands | 0 | 3 auto-approved `python -m pytest …`, 1 refused by the budget | 0 |

**Rehearsal of 19 Nov** (`e5afea6`, historical; `docs/writeup/rehearsal.json` now records the submitted commit; same settings, run A → C → B): A first diff 7.8 s
(turn 9.1 s); C first diff 2.0 s (turn 2.5 s). B **did not finish**: first diff after 68 s, then NVIDIA
returned 429 (no `Retry-After`) at 9–15 requests/min; a second attempt after 5 minutes hit 429s before any edit,
and Groq's free tier refused the fallback (413: 7,000 input tokens/min, B needs ~11k).

**Task C with the new fallback** (2026-11-19, after the rehearsal; the only real run that evening): NVIDIA 401 →
OpenRouter, first diff 8.0 s, turn 9.2 s, 4 model requests (1 NVIDIA 401 with the invalid key, 3 OpenRouter),
3/3 checks.

**Before recording B:** leave the NVIDIA key idle for some hours (no tests, no probes) and run the pre-flight
(step 2b). If NVIDIA throttles during the take, stop and re-record later rather than cutting. The OpenRouter
fallback can carry B's requests, but its free tier allows 50 requests a day without credit and B takes about
40–70, so a fallback during B may not finish. On `openrouter-free` the same cap applies to the primary: record
B first that day.

**Your clicks in Task B:** **Accept All** on each diff (expect 3–8) and **Allow once** on any command prompt
without a warning (`python -c …`, `flask …`; 0–3). Deny any ⚠ Unrestricted prompt.

| What appears | Click |
|---|---|
| Each diff | **Accept All** |
| Command prompt **without** a warning (`python -c …`, `flask …`) | **Allow once** |
| Command prompt with **⚠ Unrestricted** (`cd …`, pipes, here-docs, `python -m flask …`) | **Deny**. The refusal goes back to the model; tested on the mock (`e2e-mock.sh --deny-unrestricted`) |
| "auto-approved: …" and "command budget reached (3 per turn): …" lines | Nothing; they are shown only |

Earlier runs (before the sandbox merge; STATUS.md): first diff 39–53 s, whole turn 133–259 s, 6–12 reviews.

**Timing on the submitted build** (`f67c719`, 20 Nov). Harness rehearsal (`rehearsal.json`; times to the review
request, no editor on screen): A 10.1 s, B 42.0 s (turn 97.8 s), C 9.6 s. An independent run in VS Code measured
instruction → visible diff **28.1 s for A** and 12.6 s for C. Plan for the slower figures: the shot list below
keeps A's uncut slot at 37 s and C's at 33 s.

## Shot list

Total **3:55**. **Never cut between an instruction and its diff** (A, B and C). Cuts are allowed only in model
waiting *after* a diff has appeared; each cut gets the on-screen caption **"model waiting time cut"** (added in the
video editor, held ~2 s over the cut). The "Cut" column says where. Optional: a small "uncut" label on the uncut
waits. Required proof (never trimmed): each task's instruction → diff uncut, each verification readable, Task B's
three files, the TrueForge session for B, Task C's banner and clean `git status`.

| Time | Shot | Cut | Say / show |
|---|---|---|---|
| 0:00–0:03 | **Setup glimpse**: terminal 1 (TrueForge 0.185.1 running), `git -C ~/flask-demo log -1 --oneline` → `22d9247` | — | "VS Code extension; the agent loop runs on TrueForge in local mode." |
| 0:03–0:40 | **Task A, uncut from instruction to diff** (up to ~28 s of model waiting): `src/flask/helpers.py`, select `get_debug_flag`, `Ctrl+Alt+I`, paste instruction A, Enter → diff editor + "Review N hunk(s)" → **Choose Hunks...** (the per-hunk picker, all ticked) → accept | None before the diff. After accepting, the turn's closing seconds may be cut: caption | Point at the per-hunk picker. |
| 0:40–0:47 | **Task A verification**: `FLASK_DEBUG=off .venv/bin/python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"` → `False` | — | |
| 0:47–0:55 | **Undo (8 s)**: `Ctrl+Shift+P` → **Forge-a-thon: Undo Last Reviewed Edit** → the editor shows the original function → terminal `git status --short` (empty: file restored) | — | "Every reviewed edit can be undone." |
| 0:55–2:40 | **Task B, uncut from instruction to the first diff** (42 s in the rehearsal, up to 105 s measured earlier) — panel: paste instruction B, Send → streamed text → **Context block** (pause ~3 s: used/budget tokens, `src/flask/cli.py` ranked with its reason, skipped items) → tool calls (read_file, search_workspace, …) → first diff → **Accept All**. If the diff comes early, keep filming the next reviews in this slot | None before the first diff | "No file names in the request; the agent finds the files itself." Talk over the wait: context, tools. |
| 2:40–2:52 | **Task B, rest of the turn** (≈ 55 s of real time shown in 12 s) — each further diff → **Accept All** (measured: 4 more over `cli.py`, `tests/test_cli.py`, `docs/cli.rst`); "auto-approved: python -m pytest …" lines; any `python -c` prompt → **Allow once**; any ⚠ Unrestricted → **Deny**; summary, then hold ~2 s on **Files changed in this turn: 3** (the three paths together, with review and accepted-hunk counts) | **Cut model waiting between reviews**: caption at every cut | "Test runs are auto-approved; anything else asks; at most three commands per turn." |
| 2:52–3:00 | **TrueForge session (required for eligibility)**: panel **Open TrueForge session** → hold ~8 s on Task B's turn with its tool calls (read/search/propose_edit/run_command) and approvals | — | Note this timestamp for the write-up. |
| 3:00–3:22 | **Task B verification, 22 s readable** (commands pre-typed; let each output stay on screen ~7 s): `.venv/bin/python -m pytest tests/test_cli.py -q` (passes) · `cd examples/tutorial && ../../.venv/bin/flask --app flaskr --help` (lists `config`) · `../../.venv/bin/flask --app flaskr config` (`"SECRET_KEY": "***"`) · `cd ~/flask-demo` | — | |
| 3:22–3:55 | **Task C, uncut from instruction to diff**: `git checkout -- . && git status --short` (empty) → terminal 2 `scripts/use-models.sh nvidia-free --break-primary` (pre-typed; use the profile you are recording with) → repeat Task A → banner "Primary model failed: [Model Error] Request failed (401): Unauthorized → switched to openrouter/nemotron-3-ultra-free" (on `openrouter-free`: "… → switched to nvidia/nemotron-3-ultra") → fallback's diff (9.6–12.6 s measured) → **Reject All** → `git status --short` (empty) | None before the diff | "Invalid primary key: automatic fallback, editor responsive, workspace unchanged." Repo URL on the last frame. |

Trimmed to fit (optional material): the Stop shot (Stop is proven by tests, not by the video), Undo's re-apply, and
2 s of setup. If B's first diff came early and time is left, an optional 6 s Stop shot can go after the B
verification (send "Add type hints to every function in src/flask/cli.py", press **Stop** while it streams → status
cancelled, no edits listed). Timing check: if C's wait runs longer than ~13 s (QA once measured 29.5 s), take the
difference from the 2:40–2:52 cut segment or the optional material; never from an uncut segment or a
verification. The hard limit is 4:00.

After recording:

1. Restore the primary key (`source ~/.forge-keys.env && scripts/use-models.sh nvidia-free`, or the profile you
   recorded with).
2. Write the real timestamps of each shot into the write-up scorecard (`docs/writeup/WRITEUP.md`, section 6) and
   `docs/writeup/rehearsal.json` (`videoUrl`, `videoTimestamp`), with the team block and Team ID.
3. **Publish the PDF:** `scripts/render-writeup.sh` (must say 1–3 pages), then commit the rendered file (it is
   gitignored, so force-add it): `git add -f docs/writeup/WRITEUP.pdf && git commit -m "docs: rendered write-up"`.
   After pushing, use its GitHub link as the public PDF link in the form:
   `https://github.com/riyajenson/forgeathon/blob/main/docs/writeup/WRITEUP.pdf`. Open it in a private (signed-out)
   browser window to check that it opens.
4. `node scripts/check-submission.mjs` must pass.

## Exact instructions

- **A:** `Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.`
- **B:** `Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.`
- **C:** repeat A.

## If NVIDIA throttles on recording day

Run the pre-flight (step 2b). On a 429, switch with `scripts/use-models.sh openrouter-free` and run the pre-flight
again. The switch rewrites `config/models.json` and reruns the setup: no code change, no restart of TrueForge or
VS Code; the next turn uses the new models and the panel and banner name them. Task C then breaks the OpenRouter
key (`scripts/use-models.sh openrouter-free --break-primary`) and falls back to NVIDIA. `openrouter-paid`
(`qwen/qwen3-coder-next`) is only for after adding OpenRouter credit, and needs `--paid-ok`.

## Without keys (rehearsal only)

`scripts/dev-mock.sh` gives the same flow with the scripted demo model (Task C: `scripts/dev-mock.sh
--break-primary` / `--restore`). **Rehearsal only: the submitted video must use real models.** A real model
may choose different tools, hunks and timing than the shot list; record what actually happens.
