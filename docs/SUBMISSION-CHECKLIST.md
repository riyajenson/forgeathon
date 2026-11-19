# Submission checklist (Round 1 — deadline 20 Nov 2026, 23:59 IST)

Sources: the problem statement as summarised in `AGENTS.md` (sections 1, 2, 6, 7, 8). Status: ✅ done and
verified · 🟡 ready, needs a human step · ❌ open.

## Eligibility (pass/fail)

| Requirement | Status | Where / how verified |
|---|---|---|
| TrueForge owns the agent loop, sessions/turns and model calls | ✅ | `src/harness/turn/`, `src/harness/trueforge/`; every turn is a TrueForge session/turn (integration tests, Sessions UI) |
| Extension talks to TrueForge via its HTTP API / TypeScript SDK, never to a model provider | ✅ | Only `@truefoundry/trueforge-sdk` is used; no provider SDKs in `package.json` files |
| Editor operations are MCP tools chosen by the agent | ✅ | `src/harness/mcp/` (read, search, symbol, list, propose_edit, run_command, gather_context) |
| Model configuration lives in TrueForge; not hard-coded to one provider | ✅ | `config/models.example.json` → `scripts/setup-trueforge.mjs`; five provider examples |
| TrueForge in local mode | ✅ | `npx @truefoundry/trueforge@0.185.1`, SQLite |
| Agent definition included in the repository | ✅ | `agent/forge-coder.json`, `agent/forge-inline.json` |
| TrueForge session with turns and tool calls shown for Task B | 🟡 | Panel button / Sessions UI; must be shown in the video |
| Fork disclosure (if any) | ✅ | Built from scratch — README "Starting point" |

## Mandatory features

| Feature | Status | Evidence |
|---|---|---|
| Inline edit with in-editor diff, accept/reject, no copy-paste | ✅ | UI e2e (`scripts/test-extension-e2e.sh`), manual test A |
| Agent mode: one request, ≥ 3 files discovered and edited | ✅ | UI e2e + `scripts/e2e-mock.sh` (cli.py, test_cli.py, docs/cli.rst) — demo model; 🟡 real-model rehearsal |
| Context: `@file`, `@symbol`, automatic retrieval, budget, rationale visible | ✅ | Context engine tests (incl. Flask ranking), panel context block |
| Diff safety: preview, per-hunk accept/reject, no silent writes, undo | ✅ | Extension suites in VS Code (six outcomes, partial approval, undo), harness tests |
| Streaming and cancellation, workspace consistent | ✅ | Harness cancel tests (paused, streaming, in-flight apply), UI e2e Stop |

## Fixed tasks (on Flask 3.1.3, `22d92470`)

| Task | Status | Evidence |
|---|---|---|
| A — inline edit + `FLASK_DEBUG=off` → `False` | ✅ demo model · 🟡 real model | `scripts/e2e-mock.sh` |
| B — `flask config`, ≥ 3 files, `pytest tests/test_cli.py -q`, `flask --help`, masked JSON | ✅ demo model · 🟡 real model | `scripts/e2e-mock.sh` |
| C — invalid key → fallback, editor responsive, `git status` clean | ✅ demo model · 🟡 real model | `scripts/e2e-mock.sh`, UI e2e |

## Deliverables

| Item | Status | Notes |
|---|---|---|
| Public GitHub repository | 🟡 | `origin` = github.com/riyajenson/forgeathon; push `main` (STATUS.md has the command); check it is public |
| README supports a clean clone (setup, TrueForge start, agent loading, model config, licence) | ✅ | Followed in a fresh temp clone (see STATUS.md) |
| No API keys committed | ✅ | Secret scan of full history (STATUS.md); keys only from env |
| Licence and attribution | ✅ | `LICENSE` (MIT), `THIRD_PARTY_NOTICES.md` |
| PDF, 1–3 pages, headings in exact order (Team, Starting point, Architecture on TrueForge, How context is selected, Model setup, Scorecard, Tools used, Known limitations and what you would do with another month) | 🟡 | Draft `docs/writeup/WRITEUP.md` renders to 3 pages; fill team, models, cost, timestamps; `scripts/render-writeup.sh` |
| All models used, hosting, approx. cost, how to switch | 🟡 | Write-up section 5 has placeholders for the final models and cost |
| AI tools declared truthfully | ✅ | Write-up section 7 (Claude: Claude Code CLI + chat; OpenAI Codex via ChatGPT) |
| Demo video ≤ 4 min, public, A/B/C in order, each verified, TrueForge session for B, no cut between instruction and diff | 🟡 | `docs/DEMO-SCRIPT.md` (3:45 plan) |
| Scorecard with video timestamps | 🟡 | Fill `[mm:ss]` after recording |
| Techfest Team ID | 🟡 | Keep available for the form; add to the write-up header |
| Submission form https://forms.gle/htyWGFJRBgsg3qmx6 | 🟡 | Human |
| Links public by the deadline (repo, video) | 🟡 | Check in a signed-out browser |
