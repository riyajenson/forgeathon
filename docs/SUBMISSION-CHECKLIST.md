# Submission checklist (Round 1 — extended deadline 22 Nov 2026, 23:59 IST; finals build, tag `round1-extended-3`)

Source: the official 13-page competition PDF (held by the team; not in this repository). The requirements below are
copied from it so this checklist stands alone. Status: ✅ done and
verified · 🟡 ready, needs a human step · ❌ open.

## Eligibility (pass/fail)

| Requirement | Status | Where / how verified |
|---|---|---|
| TrueForge owns the agent loop, sessions/turns and model calls | ✅ | `src/harness/turn/`, `src/harness/trueforge/`; every turn is a TrueForge session/turn (integration tests, Sessions UI) |
| Extension talks to TrueForge via its HTTP API / TypeScript SDK, never to a model provider | ✅ | Only `@truefoundry/trueforge-sdk` is used; no provider SDKs in `package.json` files |
| Editor operations are MCP tools chosen by the agent | ✅ | `src/harness/mcp/` (read, search, symbol, list, propose_edit, run_command, gather_context) |
| Model configuration lives in TrueForge; not hard-coded to one provider | ✅ | `config/models.example.json` → `scripts/setup-trueforge.mjs`, or a named profile with `scripts/use-models.sh`; NVIDIA, OpenRouter, Groq tested; Gemini, Anthropic, OpenAI as untested examples |
| TrueForge in local mode | ✅ | `npx @truefoundry/trueforge@0.185.1`, SQLite |
| Agent definition included in the repository | ✅ | `agent/forge-coder.json`, `agent/forge-inline.json` |
| TrueForge session with turns and tool calls shown for Task B | 🟡 | **Eligibility gate.** `docs/DEMO-SCRIPT.md` shot 2:52–3:00: hold ~8 s on Task B's turn and its tool calls; note the timestamp |
| Fork disclosure (if any) | ✅ | Built from scratch — README "Starting point, versions and licence" |

The README's "Eligibility at a glance" table maps each requirement to files.

## Mandatory features

| Feature | Status | Evidence |
|---|---|---|
| Inline edit with in-editor diff, accept/reject, no copy-paste | ✅ | UI e2e (`scripts/test-extension-e2e.sh`), manual test A |
| Agent mode: one request, ≥ 3 files discovered and edited | ✅ | Real models, 22 Nov: Task B 8/8 checks on the sprint build (255107f), 6/6 on the merged build (0be9897) and 2 of 2 on p14 before the merge (`docs/writeup/rehearsal.json`). The mock runs (UI e2e, `scripts/e2e-mock.sh`) are scripted: the demo model supplies the paths and edits. At turn end the panel lists the changed files together |
| Context: `@file`, `@symbol`, automatic retrieval, budget, rationale visible | ✅ | Context engine tests (incl. Flask ranking), panel context block |
| Diff safety: preview, per-hunk accept/reject, no silent writes, undo | ✅ | Extension suites in VS Code (all six apply outcomes asserted, partial approval, undo incl. a formatting save participant), harness tests. Applied text and undo are verified by hash; save-time formatters may alter the saved file. Approved commands run in bubblewrap (read-only checkout, no network; refused if unavailable), flagged, reported and capped by the command budget (README "Safety model"). Limitation: commands can still read any file |
| Streaming and cancellation, workspace consistent | ✅ | Integration cancel tests (paused, streaming, in-flight apply); unit races (Stop before a command spawns, silent TrueForge, late writes vs retry/fallback); UI e2e Stop; extension suite: Stop after an approved edit reached VS Code saves it and reports it as saved. Edits saved earlier in a turn stay. All with the scripted model |

## Fixed tasks (on Flask 3.1.3, `22d92470`)

| Task | Status | Evidence |
|---|---|---|
| A — inline edit + `FLASK_DEBUG=off` → `False` | ✅ demo model · ✅ real model | `scripts/e2e-mock.sh`; real runs in STATUS.md |
| B — `flask config`, ≥ 3 files, `pytest tests/test_cli.py -q`, `flask --help`, masked JSON | ✅ demo model (scripted) · ✅ real model | `scripts/e2e-mock.sh` (scripted: no evidence of discovery). Real, 22 Nov: 8/8 checks on the sprint build (255107f; 60 requests, 422 s, first diff 46.5 s), 6/6 on the merged build (0be9897; 48 requests, 217 s) and 6/6 twice on p14 (5710431); no 429. `docs/writeup/rehearsal.json` |
| C — invalid key → fallback, editor responsive, `git status` clean | ✅ demo model · ✅ real model | `scripts/e2e-mock.sh`, UI e2e. Real runs: NVIDIA 401 → Groq (rehearsal), NVIDIA 401 → OpenRouter (new fallback, first diff 8.0 s; STATUS.md). Fallback on auth errors is matched by status and wording (Google's 400 format untested live) |

## Deliverables

| Item | Status | Notes |
|---|---|---|
| Public GitHub repository | ✅ | github.com/riyajenson/forgeathon is public; push the final `main` (a fast-forward) before submitting |
| README supports a clean clone (setup, TrueForge start, agent loading, model config, licence) | ✅ | Real-model quickstart first; mock mode for testing. Followed in a fresh temp clone on the mock (see STATUS.md) |
| No API keys committed | ✅ | Secret scan of full history (STATUS.md); keys only from env |
| Licence and attribution | ✅ | `LICENSE` (MIT), `THIRD_PARTY_NOTICES.md` |
| PDF, 1–3 pages (scorecard heading and rows on one page), headings in exact order (Team, Starting point, Architecture on TrueForge, How context is selected, Model setup, Scorecard, Tools used, Known limitations and what you would do with another month) | ✅ | `docs/writeup/WRITEUP.md` renders to 3 pages with the 8 headings in order (`scripts/render-writeup.sh`); rendered PDF committed |
| All models used, hosting, approx. cost, how to switch | ✅ | Write-up section 5 declares every configured model (role, provider, used in demo y/n, cost): NVIDIA Nemotron-3 Ultra primary and the same model on OpenRouter's free tier as fallback (both in the demo, $0); Groq Qwen3.8-27B spare; the paid profile and example models (never run); the opt-in embedding model `onnx-community/all-MiniLM-L6-v2-ONNX` (local CPU); the scripted test model; and Daytona as an opt-in service. Switching = edit config + rerun setup, or `scripts/use-models.sh openrouter-free` |
| AI tools declared truthfully | ✅ | Write-up section 7 and README "AI tools used" (Claude: Claude Code CLI + chat; OpenAI Codex via ChatGPT, incl. PRs #3/#4 and QA) |
| Demo video ≤ 4 min, public, A/B/C in order, each verified, TrueForge session for B, no cut between instruction and diff | 🟡 | `docs/DEMO-SCRIPT.md` (3:55 plan, measured Task B numbers). **Real models only**; record what the model actually does |
| Scorecard with video timestamps | 🟡 | Fill `[mm:ss]` after recording; README `<VIDEO_URL>` and `docs/images/` screenshots too |
| Techfest Team ID | 🟡 | Keep available for the form; add to the write-up header |
| Submission form https://forms.gle/htyWGFJRBgsg3qmx6 | 🟡 | Human |
| Public PDF link | 🟡 | After the timestamps are filled: `scripts/render-writeup.sh`, then commit the rendered PDF (`git add -f docs/writeup/WRITEUP.pdf`, it is gitignored) and push; submit https://github.com/riyajenson/forgeathon/blob/main/docs/writeup/WRITEUP.pdf as the PDF link. Check it opens signed out (DEMO-SCRIPT "After recording") |
| Links public by the deadline (repo, video, PDF) | 🟡 | Check in a signed-out browser |
| Evidence gate `node scripts/check-submission.mjs` | ✅ | Passes: `docs/writeup/rehearsal.json` records real A/B/C on the sprint build 255107f (22 Nov 19:05–19:13 IST, one run each, paced, no 429): A 6/6 (first diff 13.9 s), B 8/8 (46.5 s / 421.8 s, 60 requests), C 3/3 (401 → OpenRouter). Includes the Resume-after-fallback fix `c47e092` and the research sprint. Later commits are docs/evidence only |
