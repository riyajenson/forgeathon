# Demo video script (target 3:40, hard limit 4:00)

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
cd ~/projects/forgeathon && export GEMINI_API_KEY=... GROQ_API_KEY=...   # your two providers
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

## Shot list

| Time | Shot | Say / show |
|---|---|---|
| 0:00–0:15 | **Setup glimpse** — terminal 1 (TrueForge 0.185.1 running), terminal 2 (setup output: agents and models), `git -C ~/flask-demo log -1 --oneline` → `22d9247` | "VS Code extension; the whole agent loop runs on TrueForge in local mode; primary and fallback models from different providers." |
| 0:15–0:55 | **Task A, uncut from instruction to diff** — open `src/flask/helpers.py`, select `get_debug_flag` (lines 28–33), `Ctrl+Alt+I`, paste instruction A, Enter → progress → diff editor + "Review 2 hunks" → **Choose Hunks** (show the two hunks) → accept both | Point at the per-hunk picker. |
| 0:55–1:05 | **Task A verification** — terminal: `FLASK_DEBUG=off .venv/bin/python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"` → `False` | |
| 1:05–2:20 | **Task B, uncut from instruction to the first diff** — panel: paste instruction B, Send → streamed text → **Context block** (pause ~3 s: budget used/8000, `src/flask/cli.py` ranked first with its reason, skipped items) → tool calls (find_symbol, read_file, …) → diff for `src/flask/cli.py` → Accept All → `tests/test_cli.py` → Accept All → `docs/cli.rst` → Accept All → command approval in the panel → **Allow once** → summary | "No file names in the request; the agent found three files." Cut model waiting between diffs if needed. |
| 2:20–2:35 | **TrueForge session (required for eligibility)** — panel button **Open TrueForge session** (or the Sessions tab): hold ~10 s on Task B's turn with its list of tool calls (read/search/propose_edit/run_command, and `call_tool` if the model used deferred tools) and the approvals | Brief; note the timestamp for the write-up. |
| 2:35–2:55 | **Task B verification** — `.venv/bin/python -m pytest tests/test_cli.py -q` (passes) · `cd examples/tutorial && ../../.venv/bin/flask --app flaskr --help` (shows `config`) · `../../.venv/bin/flask --app flaskr config` (`"SECRET_KEY": "***"`) · `cd ~/flask-demo` | |
| 2:55–3:10 | **Cancel** — panel: send any request (e.g. "Add type hints to every function in src/flask/cli.py"), press **Stop** while it streams or at the first review → status cancelled, review closed; `git diff --stat` unchanged from before | "Stop cancels the TrueForge turn; nothing half-applied." |
| 3:10–3:40 | **Task C** — `git checkout -- .` (clean baseline, `git status` empty) → terminal 2: `GEMINI_API_KEY=invalid node scripts/setup-trueforge.mjs` (use your primary's variable) → repeat Task A → banner "Primary model failed: … 401 … → switched to …" → fallback's diff → **Reject All** → `git status` (empty) | "Invalid primary key: automatic fallback, editor responsive, workspace unchanged." |
| 3:40–3:45 | Closing card: repo URL | |

After recording: restore the primary key (`node scripts/setup-trueforge.mjs` with the real key), note the
timestamps of each shot for the write-up scorecard (`docs/writeup/WRITEUP.md`, section 6).

## Exact instructions

- **A:** `Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.`
- **B:** `Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.`
- **C:** repeat A.

## Without keys (rehearsal only)

`scripts/dev-mock.sh` gives the same flow with the scripted demo model (Task C: `scripts/dev-mock.sh
--break-primary` / `--restore`). **Rehearsal only: the submitted video must use real models.** A real model
may choose different tools, hunks and timing than the shot list; record what actually happens.
