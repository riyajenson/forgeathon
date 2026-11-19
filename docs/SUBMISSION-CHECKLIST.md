# Submission checklist (Round 1 — deadline 20 Nov 2026, 23:59 IST)

Source: the official 13-page competition PDF (held by the team; not in this repository). The requirements below are
copied from it so this checklist stands alone. Status: ✅ done and
verified · 🟡 ready, needs a human step · ❌ open.

## Eligibility (pass/fail)

| Requirement | Status | Where / how verified |
|---|---|---|
| TrueForge owns the agent loop, sessions/turns and model calls | ✅ | `src/harness/turn/`, `src/harness/trueforge/`; every turn is a TrueForge session/turn (integration tests, Sessions UI) |
| Extension talks to TrueForge via its HTTP API / TypeScript SDK, never to a model provider | ✅ | Only `@truefoundry/trueforge-sdk` is used; no provider SDKs in `package.json` files |
| Editor operations are MCP tools chosen by the agent | ✅ | `src/harness/mcp/` (read, search, symbol, list, propose_edit, run_command, gather_context) |
| Model configuration lives in TrueForge; not hard-coded to one provider | ✅ | `config/models.example.json` → `scripts/setup-trueforge.mjs`; NVIDIA, Groq, OpenRouter tested; Gemini, Anthropic, OpenAI as untested examples |
| TrueForge in local mode | ✅ | `npx @truefoundry/trueforge@0.185.1`, SQLite |
| Agent definition included in the repository | ✅ | `agent/forge-coder.json`, `agent/forge-inline.json` |
| TrueForge session with turns and tool calls shown for Task B | 🟡 | **Eligibility gate.** `docs/DEMO-SCRIPT.md` shot 2:48–2:56: hold ~8 s on Task B's turn and its tool calls; note the timestamp |
| Fork disclosure (if any) | ✅ | Built from scratch — README "Starting point, versions and licence" |

The README's "Eligibility at a glance" table maps each requirement to files.

## Mandatory features

| Feature | Status | Evidence |
|---|---|---|
| Inline edit with in-editor diff, accept/reject, no copy-paste | ✅ | UI e2e (`scripts/test-extension-e2e.sh`), manual test A |
| Agent mode: one request, ≥ 3 files discovered and edited | ✅ | UI e2e + `scripts/e2e-mock.sh` (cli.py, test_cli.py, docs/cli.rst) — demo model; ✅ real models (STATUS.md) |
| Context: `@file`, `@symbol`, automatic retrieval, budget, rationale visible | ✅ | Context engine tests (incl. Flask ranking), panel context block |
| Diff safety: preview, per-hunk accept/reject, no silent writes, undo | ✅ | Extension suites in VS Code (all six apply outcomes asserted, partial approval, undo incl. a formatting save participant), harness tests. Approved commands run in bubblewrap (read-only checkout, no network; refused if unavailable), flagged, reported and capped by the command budget (README "Safety model"). Limitation: commands can still read any file |
| Streaming and cancellation, workspace consistent | ✅ | Integration cancel tests (paused, streaming, in-flight apply); unit races (Stop before a command spawns, silent TrueForge, late writes vs retry/fallback); UI e2e Stop. All with the scripted model |

## Fixed tasks (on Flask 3.1.3, `22d92470`)

| Task | Status | Evidence |
|---|---|---|
| A — inline edit + `FLASK_DEBUG=off` → `False` | ✅ demo model · ✅ real model | `scripts/e2e-mock.sh`; real runs in STATUS.md |
| B — `flask config`, ≥ 3 files, `pytest tests/test_cli.py -q`, `flask --help`, masked JSON | ✅ demo model · ✅ real model | `scripts/e2e-mock.sh` |
| C — invalid key → fallback, editor responsive, `git status` clean | ✅ demo model · ✅ real model | `scripts/e2e-mock.sh`, UI e2e. Real run: NVIDIA 401 → Groq (STATUS.md). Fallback on auth errors is matched by status and wording (Google's 400 format untested live) |

## Deliverables

| Item | Status | Notes |
|---|---|---|
| Public GitHub repository | 🟡 | `origin` = github.com/riyajenson/forgeathon; push `main` (STATUS.md has the command); check it is public |
| README supports a clean clone (setup, TrueForge start, agent loading, model config, licence) | ✅ | Real-model quickstart first; mock mode for testing. Followed in a fresh temp clone on the mock (see STATUS.md) |
| No API keys committed | ✅ | Secret scan of full history (STATUS.md); keys only from env |
| Licence and attribution | ✅ | `LICENSE` (MIT), `THIRD_PARTY_NOTICES.md` |
| PDF, 1–3 pages, headings in exact order (Team, Starting point, Architecture on TrueForge, How context is selected, Model setup, Scorecard, Tools used, Known limitations and what you would do with another month) | 🟡 | Draft `docs/writeup/WRITEUP.md` renders to 3 pages; fill team, models, cost, timestamps; `scripts/render-writeup.sh` |
| All models used, hosting, approx. cost, how to switch | ✅ | Write-up section 5: NVIDIA Nemotron-3 Ultra primary, Groq Qwen3.8-27B fallback, OpenRouter spare, all free ($0); switching = edit config + rerun setup |
| AI tools declared truthfully | ✅ | Write-up section 7 (Claude: Claude Code CLI + chat; OpenAI Codex via ChatGPT) |
| Demo video ≤ 4 min, public, A/B/C in order, each verified, TrueForge session for B, no cut between instruction and diff | 🟡 | `docs/DEMO-SCRIPT.md` (3:50 plan, measured Task B numbers). **Real models only**; record what the model actually does |
| Scorecard with video timestamps | 🟡 | Fill `[mm:ss]` after recording; README `<VIDEO_URL>` and `docs/images/` screenshots too |
| Techfest Team ID | 🟡 | Keep available for the form; add to the write-up header |
| Submission form https://forms.gle/htyWGFJRBgsg3qmx6 | 🟡 | Human |
| Links public by the deadline (repo, video) | 🟡 | Check in a signed-out browser |
| Evidence gate `node scripts/check-submission.mjs` | 🟡 | Fails until the write-up placeholders are filled and `docs/writeup/rehearsal.json` (from `config/rehearsal.example.json`) records the real A/B/C runs; `node --test scripts/submission-readiness.test.mjs` 6/6 |
