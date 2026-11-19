# Demo video script (target 3:50, hard limit 4:00)

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
cd ~/projects/forgeathon && source ~/.forge-keys.env     # NVIDIA_API_KEY, GROQ_API_KEY (never shown on screen)
OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1"]' MODEL_HTTP_CONNECT_TIMEOUT_MS=3000 MODEL_HTTP_MAX_RETRIES=4 \
  SQLITE_PATH=$HOME/forge-demo-$(date +%Y%m%d-%H%M).sqlite npx -y @truefoundry/trueforge@0.185.1   # terminal 1
node scripts/setup-trueforge.mjs                                                                  # terminal 2

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

Models: NVIDIA `nemotron-3-ultra-550b-a55b` (primary), Groq `qwen3.8-27b` (fallback).

**Measured on the current code** (QA run on `37fb675`, 2026-11-19, with bubblewrap protection and the
recording settings: auto-approval on, budget 3):

| | Task A | Task B | Task C |
|---|---|---|---|
| Instruction → first diff (uncut on video) | 11.2 s | **105.5 s** | 29.5 s (2.3–2.6 s in earlier runs) |
| Whole turn | 14.2 s | 160.3 s | 35.0 s |
| Reviews | 1 | 5: `cli.py` 2, `tests/test_cli.py` 2, `docs/cli.rst` 1 | 1 (rejected) |
| Commands | 0 | 3 auto-approved `python -m pytest …`, 1 refused by the budget | 0 |

**Final rehearsal on `main`** (`docs/writeup/rehearsal.json`, same settings, run A → C → B): A first diff 7.8 s
(turn 9.1 s); C first diff 2.0 s (turn 2.5 s). B **did not finish**: first diff after 68 s, then NVIDIA
returned 429 (no `Retry-After`) at 9–15 requests/min; a second attempt after 5 minutes hit 429s before any edit,
and Groq's free tier refused the fallback (413: 7,000 input tokens/min, B needs ~11k).

**Before recording B:** leave the NVIDIA key idle for some hours (no tests, no probes), and record B first in a
session if the 429s persist. The fallback cannot carry Task B on Groq's free tier; if NVIDIA throttles during the
take, stop and re-record later rather than cutting.

**Your clicks in Task B:** **Accept All** on each diff (expect 3–8) and **Allow once** on any command prompt
without a warning (`python -c …`, `flask …`; 0–3). Deny any ⚠ Unrestricted prompt.

| What appears | Click |
|---|---|
| Each diff | **Accept All** |
| Command prompt **without** a warning (`python -c …`, `flask …`) | **Allow once** |
| Command prompt with **⚠ Unrestricted** (`cd …`, pipes, here-docs, `python -m flask …`) | **Deny**. The refusal goes back to the model; tested on the mock (`e2e-mock.sh --deny-unrestricted`) |
| "auto-approved: …" and "command budget reached (3 per turn): …" lines | Nothing; they are shown only |

Earlier runs (before the sandbox merge; STATUS.md): first diff 39–53 s, whole turn 133–259 s, 6–12 reviews.

## Shot list

Total 3:50. **Never cut between an instruction and its diff** (A, B and C). Cuts are allowed only in model
waiting *after* a diff has appeared; every such cut gets an on-screen caption **"model waiting time cut"**
(added in the video editor, held ~2 s over the cut). Optional: a small "uncut" label during the B segment.

| Time | Shot | Say / show |
|---|---|---|
| 0:00–0:04 | **Setup glimpse**: terminal 1 (TrueForge 0.185.1 running), `git -C ~/flask-demo log -1 --oneline` → `22d9247` | "VS Code extension; the agent loop runs on TrueForge in local mode." |
| 0:04–0:24 | **Task A, uncut from instruction to diff** (11 s measured): `src/flask/helpers.py`, select `get_debug_flag`, `Ctrl+Alt+I`, paste instruction A, Enter → diff editor + "Review N hunk(s)" → **Choose Hunks...** (show the per-hunk picker, all ticked) → accept | Point at the per-hunk picker. |
| 0:24–0:30 | **Task A verification**: `FLASK_DEBUG=off .venv/bin/python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"` → `False` | |
| 0:30–0:42 | **Undo (12 s)**: `Ctrl+Shift+P` → **Forge-a-thon: Undo Last Reviewed Edit** → the editor shows the original function → terminal `git status --short` (empty: file restored) → editor `Ctrl+Z`, `Ctrl+S` (change back) → `git status --short` shows `M src/flask/helpers.py` | "Every reviewed edit can be undone exactly." (Tested: `scripts/test-extension-e2e.sh`, Task A.) |
| 0:42–2:34 | **Task B, uncut from instruction to the first diff** (105 s measured) — panel: paste instruction B, Send → streamed text → **Context block** (pause ~3 s: used/budget tokens, `src/flask/cli.py` ranked with its reason, skipped items) → tool calls (read_file, search_workspace, …) → first diff → **Accept All** | "No file names in the request; the agent finds the files itself." Talk over the wait: context, tools. |
| 2:34–2:48 | **Task B, rest of the turn, model waiting cut** (≈ 55 s of real time) — each further diff → **Accept All** (measured: 4 more over `cli.py`, `tests/test_cli.py`, `docs/cli.rst`); "auto-approved: python -m pytest …" lines; any `python -c` prompt → **Allow once**; any ⚠ Unrestricted → **Deny**; "command budget reached" line; summary | Caption **"model waiting time cut"** at every cut. "Test runs are auto-approved; anything else asks; at most three commands per turn." |
| 2:48–2:56 | **TrueForge session (required for eligibility)**: panel **Open TrueForge session** → hold ~8 s on Task B's turn with its tool calls (read/search/propose_edit/run_command) and approvals | Note this timestamp for the write-up. |
| 2:56–3:08 | **Task B verification**: `.venv/bin/python -m pytest tests/test_cli.py -q` (passes) · `cd examples/tutorial && ../../.venv/bin/flask --app flaskr --help` (lists `config`) · `../../.venv/bin/flask --app flaskr config` (`"SECRET_KEY": "***"`) · `cd ~/flask-demo` | |
| 3:08–3:14 | **Stop**: panel, send "Add type hints to every function in src/flask/cli.py", press **Stop** while it streams → status cancelled, no edits listed | "Stop cancels the TrueForge turn; nothing half-applied." |
| 3:14–3:50 | **Task C, uncut from instruction to diff**: `git checkout -- . && git status --short` (empty) → terminal 2 `NVIDIA_API_KEY=invalid node scripts/setup-trueforge.mjs` → repeat Task A → banner "Primary model failed: … 401 … → switched to groq/qwen3-8-27b" → fallback's diff → **Reject All** → `git status --short` (empty) | "Invalid primary key: automatic fallback, editor responsive, workspace unchanged." Repo URL on the last frame. |

Timing check: the C slot leaves ~22 s for instruction → diff. If the rehearsal's C wait is longer (QA measured
29.5 s), take the difference from the 2:34–2:48 cut segment; never from an uncut segment. The hard limit is 4:00.

After recording: restore the primary key (`source ~/.forge-keys.env && node scripts/setup-trueforge.mjs`) and
write the real timestamps of each shot into the write-up scorecard (`docs/writeup/WRITEUP.md`, section 6).

## Exact instructions

- **A:** `Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.`
- **B:** `Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.`
- **C:** repeat A.

## Without keys (rehearsal only)

`scripts/dev-mock.sh` gives the same flow with the scripted demo model (Task C: `scripts/dev-mock.sh
--break-primary` / `--restore`). **Rehearsal only: the submitted video must use real models.** A real model
may choose different tools, hunks and timing than the shot list; record what actually happens.
