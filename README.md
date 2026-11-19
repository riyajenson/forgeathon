# Forge — a VS Code coding agent on TrueForge

A VS Code extension whose entire agent loop runs on **[TrueForge](https://github.com/truefoundry/trueforge)
0.185.1** in local mode. Built for the TrueFoundry Forge-a-thon (Techfest IIT Bombay), Round 1.

- **Inline edit** — select code, `Ctrl+Alt+I`, type an instruction, review the diff hunk by hunk, accept, undo.
- **Agent mode** — one request in the panel; the agent finds the relevant files itself, proposes one reviewed
  diff per file, and runs the tests after asking you.
- **Context assembly** — `@file:`/`@symbol:` mentions, the selection and the active file, plus automatic
  retrieval (BM25 over code, symbol index, test/doc pairing) within a token budget, with the chosen files,
  reasons and skipped items shown in the panel.
- **Diff safety** — proposals never touch disk until you accept them; per-hunk accept/reject; stale-file
  refusal; undo (exact original bytes, even with format-on-save). Shell commands run only after you approve
  them; they are **not sandboxed** (see [run_command: what is and is not protected](#run_command-what-is-and-is-not-protected)).
- **Streaming and cancellation** — streamed text and tool calls; Stop cancels the TrueForge turn and closes
  any open review without writing.
- **Resilience** — retry on transient errors (rate limits honour `Retry-After`), automatic fallback to a
  second model from a different provider, never after the turn changed the workspace.

![Architecture](docs/writeup/architecture.svg)

TrueForge owns the agent loop, sessions, turns, tool approvals and model calls. The extension talks to
TrueForge only through the harness (TrueForge SDK over HTTP); editor operations are MCP tools that TrueForge
calls. Model choice lives in TrueForge's configuration (`config/models.json` → setup script); nothing in the
extension is tied to a provider.

## Repository layout

| Path | What |
|---|---|
| `extension/` | VS Code extension: commands, inline review, agent panel, `EditorPort` (editor reads/writes) |
| `src/harness/` | `forge-harness`: TrueForge adapter (turns, approvals, cancel, retry, fallback), MCP server and tools, context engine, review core |
| `contracts/` | Shared TypeScript contract between extension and harness (protocol 0.4.2) |
| `agent/` | **TrueForge agent definitions**: `forge-coder.json` (agent mode), `forge-inline.json` (inline edit) |
| `config/` | `models.example.json` (real providers), `models.mock.example.json` (demo model) |
| `scripts/` | setup, demo mode, end-to-end checks, real-model smoke test, extension tests |
| `docs/` | status, write-up, demo script, manual test, submission checklist, branching convention |
| `spike/` | TrueForge 0.185.1 feasibility spike and its findings (not shipped) |

## Prerequisites

- Windows 11 with **WSL 2 (Ubuntu)**, or any Linux. Everything below runs inside WSL.
- **VS Code** on Windows with the **WSL** extension (the extension host runs in WSL).
- **Node.js ≥ 22.14** in WSL (e.g. `nvm install 24`), npm, git.
- **Python ≥ 3.10** with `venv` for the Flask demo workspace.

## Install and build (once, for both modes below)

```bash
git clone https://github.com/riyajenson/forgeathon.git && cd forgeathon
npm --prefix src/harness ci && npm --prefix src/harness run build
(cd extension && npm ci && npm run compile)
```

## Quick start without model keys (demo mode)

```bash
scripts/dev-mock.sh            # scripted demo model + fresh TrueForge on :8790 + setup; Ctrl+C stops all
```

The demo model is a local scripted stand-in for an LLM: it calls the same tools a real model would and
knows the three fixed tasks. It costs nothing and needs no keys. Then open the extension (below).

## With real models

1. Pick a primary and a fallback model from **different providers**:

   ```bash
   cp config/models.example.json config/models.json      # gitignored
   # edit agents.primaryModel / agents.fallbackModel; examples: Gemini, Groq, OpenRouter, Anthropic, OpenAI
   export GEMINI_API_KEY=...  GROQ_API_KEY=...            # only the variables your two providers use
   ```

2. Start TrueForge 0.185.1 in local mode (keep it running):

   ```bash
   OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1"]' MODEL_HTTP_CONNECT_TIMEOUT_MS=3000 MODEL_HTTP_MAX_RETRIES=1 \
     SQLITE_PATH=$HOME/forge-data/trueforge.sqlite npx -y @truefoundry/trueforge@0.185.1
   ```

   `OUTBOUND_URL_ALLOWED_HOSTS` lets TrueForge reach the editor's MCP server on 127.0.0.1 (its SSRF guard
   blocks loopback otherwise). The UI is at http://localhost:8790 — **Sessions** shows every turn and tool call.

3. Load the model providers, the editor connector and the agent definitions (idempotent):

   ```bash
   node scripts/setup-trueforge.mjs             # --dry-run prints the plan with keys redacted
   ```

   This registers each provider whose key is set, the `vscode` MCP connector, and four agents built from
   `agent/*.json`: `forge-coder`, `forge-inline` (primary model) and `forge-coder-fallback`,
   `forge-inline-fallback` (fallback model). **Switching models = edit `config/models.json` and rerun setup.**

## Open the extension

1. Prepare a Flask 3.1.3 workspace (the fixed demo target):

   ```bash
   git clone https://github.com/pallets/flask ~/flask-demo && cd ~/flask-demo && git checkout 22d92470
   python3 -m venv .venv && echo ".venv/" >> .git/info/exclude
   .venv/bin/pip install -q -e . "pytest==9.0.2"      # Flask's own lockfile pins pytest 9.0.2
   ```

2. In VS Code: **WSL: Connect to WSL**, open the `forgeathon/extension` folder, press **F5**
   ("Launch Forge editor"). In the Extension Development Host, open `~/flask-demo`.
3. Commands (`Ctrl+Shift+P`, "Forge-a-thon"): **Inline Edit** (`Ctrl+Alt+I`), **Open Agent Panel**,
   **Accept All Hunks**, **Reject All Hunks**, **Review Hunks**, **Undo Last Reviewed Edit**, **Stop Turn**.
   Settings: `forge.trueforgeUrl` (default `http://127.0.0.1:8790`), `forge.mcpPort` (47615),
   `forge.context.budgetTokens` (8000).

## The three fixed tasks

| Task | Do | Verify |
|---|---|---|
| A — inline edit | Open `src/flask/helpers.py`, select `get_debug_flag`, `Ctrl+Alt+I`: *Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.* Review → Accept | `FLASK_DEBUG=off .venv/bin/python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"` → `False` |
| B — agent mode | Agent panel, naming no files: *Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "\*\*\*". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.* Review each file; allow the test command | `.venv/bin/python -m pytest tests/test_cli.py -q` · `cd examples/tutorial && ../../.venv/bin/flask --app flaskr --help` lists `config` · `../../.venv/bin/flask --app flaskr config` prints JSON with `"SECRET_KEY": "***"` |
| C — resilience | Break the primary (demo mode: `scripts/dev-mock.sh --break-primary`; real models: rerun setup with a wrong key for the primary), repeat Task A | Panel banner "Primary model failed: … → switched to …" (fallback) and, after rejecting, `git status` shows no changes. Restore: `scripts/dev-mock.sh --restore` / rerun setup |

## Tests

| Command | What it proves | Needs |
|---|---|---|
| `npm --prefix src/harness test` | Harness unit tests (review core, MCP tools, ignore policy, regex deadline, run_command cancel races, context engine incl. Flask ranking, setup, errors) and turn races against an in-memory TrueForge stand-in (late writes vs retry/fallback, silent server vs Stop/watchdog) | — (the Flask ranking test needs a Flask 3.1.3 checkout at `FORGE_FLASK_DIR` or `~/projects/flask-3.1.3`; otherwise it is skipped) |
| `npm --prefix src/harness run test:integration` | Turns against real TrueForge with a scripted model: approvals, partial accept, deny, cancel races, 401/refused/429/watchdog → retry/fallback, run_command, setup | TrueForge on :8790 started as above |
| `scripts/e2e-mock.sh` | Tasks A, B, C end to end through the harness on a copy of Flask 3.1.3, with the verification commands | Flask checkout: `--flask DIR`, default `~/flask-demo`, else `~/projects/flask-3.1.3` |
| `scripts/test-extension.sh` | Extension suites inside a real VS Code window (EditorPort, review, panel) | A display (WSLg); fetches 3 libraries without sudo |
| `scripts/test-extension-e2e.sh` | Tasks A, B, Stop, C through the extension UI code against TrueForge + demo model | as above + Flask checkout |
| `node scripts/smoke-real-model.mjs --tasks A,C` | Same checks as `e2e-mock.sh` with your real models | `config/models.json`, keys, TrueForge |

## run_command: what is and is not protected

The agent can run shell commands (to run the tests) through the `run_command` MCP tool. It is **not a
sandbox**: an approved command runs as you, with your file access, and can change files without hunk review.
What the harness does:

- Nothing runs without your approval of that exact command and directory (one use); a command never starts
  after Stop, and Stop kills its whole process group.
- Commands other than `pytest`, `python -m pytest`, `python -c`, `flask`, `git status` and `git diff`
  (without shell operators) are marked **Unrestricted** with a warning in the approval prompt.
- The working directory must resolve (symlinks included) inside the workspace; the command gets your
  environment **minus** credential-like variables (`*KEY*`, `*TOKEN*`, `*SECRET*`, `*PASSW*`, …) and editor IPC
  handles; it is killed after its timeout (default 120 s, max 600 s); output is capped.
- `git status` is compared before and after; files the command changed are reported to you and to the model as
  "changed outside review". A command counts as a write: no retry or fallback after it.

Residual risk: a command you approve can still write anywhere you can (absolute paths, git-ignored files),
reach the network, or read files; git cannot see changes to ignored files or outside the workspace. Deny
commands you do not understand.

## Starting point, licence and attribution

- **Built from scratch, not a fork.** No editor or agent code was copied from another project; the first
  commit of this repository is the TrueForge spike. The extension was scaffolded from an empty folder.
- Licence: **MIT** (`LICENSE`). Third-party components and licences: `THIRD_PARTY_NOTICES.md` — TrueForge
  (MIT), TrueForge SDK (MIT), MCP TypeScript SDK (MIT), zod (MIT), TypeScript (Apache-2.0); Flask 3.1.3
  (BSD-3-Clause) is the demo target, cloned separately.
- **No secrets are committed.** Keys come only from environment variables; `config/models.json` is gitignored;
  the MCP server listens on 127.0.0.1 with a random bearer token per session; the demo "keys" are fixed dummy
  values understood only by the local demo model.
- AI assistance used to build this project is declared in the write-up (`docs/writeup/WRITEUP.md`, "Tools used").

## More

- `docs/STATUS.md` — what works, how it was verified, open items
- `docs/MANUAL-TEST.md` — step-by-step manual check in VS Code
- `docs/DEMO-SCRIPT.md` — the ≤ 4-minute video shot list
- `docs/writeup/WRITEUP.md` — the write-up (render: `scripts/render-writeup.sh`)
- `spike/FINDINGS.md`, `docs/harness/` — TrueForge behaviour verified during development
