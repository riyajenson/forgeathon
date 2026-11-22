# Manual test in VS Code (≈ 20 minutes)

Most of this is also automated (`scripts/test-extension-e2e.sh` drives the same code in a real VS Code
window), but the keybinding, input box, notifications and the look of the panel can only be checked by
hand. Run it once with the demo model and once with the real models before recording.

## Setup

| # | Step | Expected |
|---|---|---|
| 0.1 | `npm --prefix src/harness ci && npm --prefix src/harness run build && (cd extension && npm ci && npm run compile)` | No errors |
| 0.2 | Demo model: `scripts/dev-mock.sh` · or real models: start TrueForge (README) + `node scripts/setup-trueforge.mjs` | Setup lists 4 agents and "models available: … (primary), … (fallback)" |
| 0.3 | Flask workspace at `22d92470` with `.venv` (README, "Open the extension") | `git -C ~/flask-demo status --short` prints nothing |
| 0.4 | VS Code → **WSL: Connect to WSL** → open `~/projects/forgeathon/extension` → **F5** → open `~/flask-demo` in the new window | Extension Development Host opens; no error notification |

## Task A — inline edit, review, undo

| # | Step | Expected |
|---|---|---|
| A.1 | Open `src/flask/helpers.py`, select lines 28–33 (`get_debug_flag`) | Selection visible |
| A.2 | `Ctrl+Alt+I` | Input box "How should the selection change?" |
| A.3 | Paste instruction A, Enter | Notification "Forge inline edit — waiting for the model…" with **Cancel** |
| A.4 | Wait | Diff editor "src/flask/helpers.py - proposed changes" opens with the hunk picker "Select hunks to accept" above it; its title bar has ✓ and ✕ (the demo model makes 2 hunks; a real model may differ) |
| A.5 | Look at the picker; hover ✓ and ✕ | Every hunk listed (e.g. the docstring and the `{"0", "false", "no", "off", "n"}` line), all checked; tooltips "Accept all hunks" / "Reject all hunks". Escape hides the picker, **Review hunks** in the status bar reopens it |
| A.6 | Uncheck one hunk; inspect the proposed side before Enter | The editor diff immediately shows the exact result with only checked hunks; the workspace file is still unchanged |
| A.7 | Press Enter | Only the checked hunks change `helpers.py`; the file is saved (no dirty dot) |
| A.8 | Command palette: **Forge-a-thon: Undo Last Reviewed Edit** | `helpers.py` back to the original; `git status` clean |
| A.9 | Repeat A.1–A.5, click **✓** | Both hunks applied and saved |
| A.10 | Terminal: `FLASK_DEBUG=off .venv/bin/python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"` | `False` |
| A.11 | Same with `FLASK_DEBUG=N` and `FLASK_DEBUG=1` | `False`, `True` |
| A.12 | `git checkout -- .` | Clean |

## Task B — agent panel

| # | Step | Expected |
|---|---|---|
| B.1 | **Forge-a-thon: Open Agent Panel** | Panel "Forge Agent" beside the editor: Task box, Send, Stop (disabled) |
| B.2 | Paste instruction B, **Send** | Stop enabled; status running; text streams in |
| B.3 | Look at **Context** | "N / 4000 estimated tokens"; list starts with files such as `src/flask/cli.py` with a reason; **Skipped** list with reasons |
| B.4 | Look at **Tool activity** | Entries such as `find_symbol | routes_command`, `read_file | src/flask/cli.py lines …` |
| B.5 | First review (diff + hunk picker) for `src/flask/cli.py` | Diff shows the new `config_command` and its registration; **✓** |
| B.6 | Reviews for `tests/test_cli.py` and `docs/cli.rst` | Accept each |
| B.7 | **Command approval** section in the panel shows `$ python -m pytest tests/test_cli.py -q` | **Allow once**; tool activity shows the command result |
| B.8 | Turn ends | Summary text; "Model: … | … input / … output tokens"; **Reviewed edits** lists 3 files `saved` |
| B.9 | **Open TrueForge session** | Browser opens the session: one turn with tool calls and approvals |
| B.10 | `.venv/bin/python -m pytest tests/test_cli.py -q` | passes |
| B.11 | `cd examples/tutorial && ../../.venv/bin/flask --app flaskr --help` | lists `config` |
| B.12 | `../../.venv/bin/flask --app flaskr config` | JSON; `"SECRET_KEY": "***"`; other values visible |
| B.13 | `cd ~/flask-demo && git checkout -- .` | Clean |

## Stop / cancellation

| # | Step | Expected |
|---|---|---|
| S.1 | Panel: send instruction B again; press **Stop** while text streams | Status "Stopping…" then cancelled; Send enabled again; no files changed |
| S.2 | Send instruction B; when the first diff appears press **Stop** | Review notification/picker closes; no files changed (`git status` clean) |
| S.3 | Inline edit (A.1–A.3), then **Cancel** on the progress notification | Turn stops; no diff applied |

## Task C — resilience

| # | Step | Expected |
|---|---|---|
| C.1 | Demo: `scripts/dev-mock.sh --break-primary` · real: rerun setup with a wrong value in the primary's key variable | "agent … updated" lines |
| C.2 | Repeat Task A (A.1–A.4) | Panel/notification banner "Primary model failed: … (401) … → switched to <fallback model>"; the fallback model's diff appears; editor stays responsive |
| C.3 | **✕** in the hunk picker | No change; `git status` clean |
| C.4 | Restore: `scripts/dev-mock.sh --restore` · real: rerun setup with the real key | Task A works with the primary again |

## Other checks

| # | Step | Expected |
|---|---|---|
| O.1 | Stop TrueForge, run an inline edit | Clear error "TrueForge is not reachable at …" (no hang) |
| O.2 | Edit `helpers.py` by hand after a proposal appears, then accept | Refused as stale; your edit is kept |
| O.3 | `@file:src/flask/cli.py` or `@symbol:routes_command` in a panel request | Context block lists it with source "explicit" |
| O.4 | `~/.forge/turns.jsonl` | One JSON line per turn: models, attempts, tokens, timing; no code or prompt text |
