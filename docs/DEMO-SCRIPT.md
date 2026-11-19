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
OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1"]' MODEL_HTTP_CONNECT_TIMEOUT_MS=3000 MODEL_HTTP_MAX_RETRIES=1 \
  SQLITE_PATH=$HOME/forge-demo-$(date +%Y%m%d-%H%M).sqlite npx -y @truefoundry/trueforge@0.185.1   # terminal 1
node scripts/setup-trueforge.mjs                                                                  # terminal 2
```

3. VS Code: **WSL: Connect to WSL** → open `~/projects/forgeathon/extension` → **F5** → in the Extension
   Development Host open `~/flask-demo`. Do one throw-away inline edit to warm up, then
   `git -C ~/flask-demo checkout -- .`
4. Layout: editor left, Forge agent panel right (Forge-a-thon: Open Agent Panel), integrated terminal
   bottom (cwd `~/flask-demo`). Browser tab with http://localhost:8790 → Sessions, ready.
5. Readability: `"editor.fontSize": 16`, `"terminal.integrated.fontSize": 15`, `"window.zoomLevel": 1`,
   minimap off, close unrelated panels, OS notifications off (keep VS Code notifications on: the review
   prompt is one). 1920×1080 recording.
6. Have the three instructions in a text file to paste (exact wording below).
7. Decide the Task B command setting before recording (see "Task B: what to expect"). Default and measured:
   `forge.autoApproveSafeCommands` **off**.

## Task B: what to expect (measured with the real models, 2026-11-19)

Models: NVIDIA `nemotron-3-ultra-550b-a55b` (primary), Groq `qwen3.8-27b` (fallback). Task B is long and
varies between runs; all three real runs passed every check, but none met the ≤ 3 approvals / 1 review per
file target:

| Run | First diff after | Whole turn | Reviews (per file) | Command prompts (of which ⚠ Unrestricted) |
|---|---|---|---|---|
| 1 (old instructions) | — | 133 s | 7 (`cli.py` 3, `test_cli.py` 2, `cli.rst` 1, `api.rst` 1) | 15 |
| 2 (tuned instructions) | 39 s | 259 s | 12 (`cli.py` 7, `test_cli.py` 4, `cli.rst` 1) | 17 (5) |
| 3 (tuned again) | 39 s | 240 s | 11 (`cli.py` 8, `test_cli.py` 2, `cli.rst` 1) | 7 (4) |

Run 3's extra `cli.py` reviews came mostly from the model sending `edits` as a JSON string, which the harness
then refused; that is fixed since (accepted as the array), but not yet re-measured on a real Task B run.

**Clicks during Task B (setting off):**
- Each diff: **Accept All** (expect about 4–12 reviews; most are `src/flask/cli.py`).
- Command prompt **without** a warning (`python -m pytest tests/test_cli.py…`): **Allow once**.
- Command prompt with **⚠ Unrestricted** (`cd …`, pipes, here-docs, `python -m flask …`): **Deny**. The agent's
  instructions forbid these; the refusal reason goes back to the model. (Untested with the real model: the
  measured runs allowed everything.)
- Measured when allowing everything: 7–17 command prompts (4–5 of them ⚠ Unrestricted). Denying the Unrestricted
  ones should leave fewer, but how many is not measured; record what happens.

Optional, to shorten the shot: `"forge.autoApproveSafeCommands": true` in the Extension Development Host's
settings. Listed commands then appear in the panel as **"auto-approved: python -m pytest …"** with no prompt;
only ⚠ Unrestricted commands still ask (Deny them), and every diff is still reviewed. Say so on screen if used.

## Shot list

| Time | Shot | Say / show |
|---|---|---|
| 0:00–0:12 | **Setup glimpse** — terminal 1 (TrueForge 0.185.1 running), terminal 2 (setup output: agents and models), `git -C ~/flask-demo log -1 --oneline` → `22d9247` | "VS Code extension; the whole agent loop runs on TrueForge in local mode; primary and fallback models from different providers." |
| 0:12–0:45 | **Task A, uncut from instruction to diff** (measured 8.5–11.4 s, 3 requests) — open `src/flask/helpers.py`, select `get_debug_flag` (lines 28–33), `Ctrl+Alt+I`, paste instruction A, Enter → progress → diff editor + "Review N hunks" (the real model produced 1 hunk) → **Choose Hunks** (show the picker) → accept | Point at the per-hunk picker. |
| 0:45–0:55 | **Task A verification** — terminal: `FLASK_DEBUG=off .venv/bin/python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"` → `False` | |
| 0:55–1:40 | **Task B, uncut from instruction to the first diff** (≈ 40 s) — panel: paste instruction B, Send → streamed text → **Context block** (pause ~3 s: 7,456/8,000 tokens, `src/flask/cli.py` ranked first with its reason, 7 skipped) → tool calls (read_file, search_workspace, …) → first diff (`src/flask/cli.py`) → **Accept All** | "No file names in the request; the agent finds the files itself." |
| 1:40–2:25 | **Task B, rest of the turn, model waiting cut** (real time ≈ 3–3.5 min) — each further diff → **Accept All** (`cli.py`, `tests/test_cli.py`, `docs/cli.rst`); pytest prompt → **Allow once** (or "auto-approved" line); ⚠ Unrestricted prompt → **Deny** → summary with the test result | Keep each click on screen ~2 s; cut only the waiting between them. |
| 2:25–2:37 | **TrueForge session (required for eligibility)** — panel button **Open TrueForge session** (or the Sessions tab): hold ~10 s on Task B's turn with its list of tool calls (read/search/propose_edit/run_command, and `call_tool` if the model used deferred tools) and the approvals | Brief; note the timestamp for the write-up. |
| 2:37–2:57 | **Task B verification** — `.venv/bin/python -m pytest tests/test_cli.py -q` (passes) · `cd examples/tutorial && ../../.venv/bin/flask --app flaskr --help` (shows `config`) · `../../.venv/bin/flask --app flaskr config` (`"SECRET_KEY": "***"`) · `cd ~/flask-demo` | |
| 2:57–3:10 | **Cancel** — panel: send any request (e.g. "Add type hints to every function in src/flask/cli.py"), press **Stop** while it streams or at the first review → status cancelled, review closed; `git diff --stat` unchanged from before | "Stop cancels the TrueForge turn; nothing half-applied." |
| 3:10–3:45 | **Task C** — `git checkout -- .` (clean baseline, `git status` empty) → terminal 2: `NVIDIA_API_KEY=invalid node scripts/setup-trueforge.mjs` → repeat Task A → banner "Primary model failed: [Model Error] Request failed (401): Unauthorized → switched to groq/qwen3-8-27b" (measured: 2.6 s for the whole turn) → fallback's diff → **Reject All** → `git status` (empty) | "Invalid primary key: automatic fallback, editor responsive, workspace unchanged." |
| 3:45–3:50 | Closing card: repo URL | |

After recording: restore the primary key (`source ~/.forge-keys.env && node scripts/setup-trueforge.mjs`), note the
timestamps of each shot for the write-up scorecard (`docs/writeup/WRITEUP.md`, section 6).

## Exact instructions

- **A:** `Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.`
- **B:** `Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.`
- **C:** repeat A.

## Without keys (rehearsal only)

`scripts/dev-mock.sh` gives the same flow with the scripted demo model (Task C: `scripts/dev-mock.sh
--break-primary` / `--restore`). **Rehearsal only: the submitted video must use real models.** A real model
may choose different tools, hunks and timing than the shot list; record what actually happens.
