---
pdf_options:
  format: A4
  margin: 10mm 14mm
stylesheet: writeup.css
---

# Forge — a VS Code coding agent on TrueForge

Repository: https://github.com/riyajenson/forgeathon · Video: https://drive.google.com/file/d/1iol4V8OX0IGQ95BHoVEmTl59FTz9snNn/view?usp=sharing · Techfest Team ID: TM-C5CB9D87285

## 1. Team

Riya Jenson (GitHub `riyajenson`, Vellore Institute of Technology, Vellore) · Shriya Prasad Sawant (GitHub `shriyapsawant21-wq`, Vellore Institute of Technology, Vellore) ·
Akil Ansari (GitHub `dumbly-smart`, Vellore Institute of Technology, Vellore) · Divyam Agrawal (GitHub `divyamagrawal06`, Vellore Institute of Technology, Vellore)

## 2. Starting point

Built **from scratch**; not a fork of any editor or agent. The first commit is a TrueForge 0.185.1 feasibility
spike (`spike/FINDINGS.md`); the VS Code extension was scaffolded from an empty folder. TrueForge itself is
used unmodified as the harness (`npx @truefoundry/trueforge@0.185.1`, local mode, SQLite).

## 3. Architecture on TrueForge

![Architecture](architecture.svg)

**TrueForge owns the agent loop.** Two agent definitions live in the repo (`agent/forge-inline.json`,
`agent/forge-coder.json`); the setup script registers them with the primary model and generates
`-fallback` variants with the fallback model. Dynamic sub-agents are on for `forge-coder` (told to explore read-only; a
sub-agent's edits would still pass the same review); generative UI, ask-user and the TrueForge sandbox are off (Daytona: opt-in spike, §5);
agent-mode compaction fires at 40k input tokens (inline: 60k), its start and finish shown as panel status lines; iteration limits 8 (inline) and 80 (agent).

**Harness (`forge-harness`).** Maps each editor turn to a TrueForge session/turn via the TrueForge SDK, normalises the
event stream (text, tool calls, context report, review/command requests, fallback, done) and answers `tool.approval_required`
with the user's per-hunk decision (the deny reason reaches the model). **Harness-enforced guardrails:** per-turn budgets of
3 test runs and 3 other commands (inline 1 + 1; further `run_command` calls are refused without prompting; `cd … && …` is
refused with the corrected call, free); approved commands run in **bubblewrap** (workspace, its venv and base interpreter
prefix, and the system runtime, read-only; no home directory, private `/tmp`, no network, no keys; output redacted for key
patterns; refused if unavailable); a tool still running after a turn holds the session.

**Editor tools are MCP tools** served by the harness inside the extension host (127.0.0.1, bearer token):
`gather_context`, `read_file`, `search_workspace`, `propose_edit`, `run_command`, and the **deferred**
`find_symbol` and `list_files` (loaded on demand through TrueForge's `call_tool`). Only `propose_edit` and
`run_command` require approval. TrueForge sends `x-tfg-session-id` on every MCP call, so an approval can be
used only by the tool call of the same session, once, with the same arguments.

**Diff safety.** `propose_edit` never writes by itself. The approved text (the original with only the accepted
hunks applied) goes to the editor's `applyText`, which checks the buffer hash, applies one `WorkspaceEdit`, saves,
and returns one of six outcomes (stale, approval missing, failed before apply, applied but unsaved, save failed,
saved). The reviewed text is verified by hash; save-time formatters may alter the saved file. Undo, guarded by
the post-save hash, restores the reviewed original text (saved without save participants).

**Cancellation.** Stop closes the approval gate, cancels the TrueForge turn, kills a running command's process group
and closes the open review; an approved command never starts after Stop. An approved edit that already reached VS Code
is saved and reported before `done`; edits saved earlier stay. Waits on TrueForge are bounded (the turn ends exactly once),
and retry or fallback happen only when every tool call of the failed attempt has settled and nothing approved is unfinished.

## 4. How context is selected

1. **Pinned first:** the user's selection, `@symbol:Name` (resolved through the symbol index),
   `@file:path`, then an outline of the active file. Automatic results cannot displace these choices.
2. **Automatic retrieval:** functions, classes and doc sections ranked by BM25 over split identifiers and prose, plus symbol,
   decorator, exact-path and path-term evidence; code, tests and docs joined by one-hop imports, importers, test names and mentions.
3. **Budgeted packing** (default 4,000 estimated tokens, resent with every request): up to eight query-focused outlines
   (≤ 120 tokens each), then relevant chunks; a large chunk becomes a focused excerpt (≤ 600 tokens, ≤ 30% of the budget) that
   marks omitted lines. Everything else is listed as **skipped** with a reason; ranks and reasons are in the context report.
4. The agent can request more with `gather_context`.
5. **Selective semantic ranking** (`forge.context.semanticSearch`, opt-in, off by default): only weak lexical/structural
   shortlists are considered. Fully cached semantic scores can reorder that shortlist synchronously. On a cache
   miss, Forge returns the lexical/structural result immediately and warms vectors in the background for later
   requests. The optional CPU runtime is installed with `scripts/enable-semantic-search.sh` (~230 MB; embedding model in §5); when it
   is absent or fails, the context report explains why the deterministic fallback was used.
6. **One read policy for every source** (retrieval, references, selection and every read tool): credentials-shaped files
   (`.env*`, keys, `.netrc`, …) are refused **by file name only**; binary files are refused; `read_file` output is capped (600
   lines / 60,000 characters). Files that are sent to the model are also kept in TrueForge's local traces (SQLite).

The workspace index is built in the background at start-up and reused. On a 13-task Forge + Flask 3.1.3 retrieval
benchmark at 4,000 tokens (lexical/structural; reproduced on `c865952`, 3 runs): recall@5 0.776, MRR 0.721, 25/30 expected
files packed, median assembly 3–5 ms (0.801 / 0.733 on `658243d`; the earlier single-run baseline 0.699 / 0.660, 9/30).
These are directional retrieval measurements, not end-to-end coding success.

## 5. Model setup

| Role | Model · provider | Used in demo | Cost |
|---|---|---|---|
| Primary (agent and inline) | `nvidia/nemotron-3-ultra-550b-a55b` · NVIDIA API Catalog, free tier | yes | $0 |
| Fallback | `nvidia/nemotron-3-ultra-550b-a55b:free` (same model, NVIDIA upstream; 50 requests/day) · OpenRouter | yes (Task C) | $0 |
| Spare (fallback in earlier rehearsals) | `qwen/qwen3.8-27b` · Groq, free tier | no | $0 |
| Paid profile (`--paid-ok`), never run | `qwen/qwen3-coder-next` · OpenRouter | no | paid |
| Examples in the config, never run | `openai/gpt-oss-120b` (Groq), `gemini-flash-latest` (Google), `claude-sonnet-5-5`, `claude-haiku-5-5` (Anthropic), `gpt-6-luna` (OpenAI) | no | — |
| Embeddings for opt-in semantic ranking | `onnx-community/all-MiniLM-L6-v2-ONNX`, local CPU; downloaded from Hugging Face on first use | no (off) | $0 |
| Automated tests, mock mode | scripted demo model as `demo-primary/scripted` and `demo-fallback/scripted` (local) | no | $0 |
| Service, opt-in spike | Daytona sandbox (TrueForge sandbox provider, skill, Code Mode; `scripts/daytona-spike.sh`) · Daytona cloud | no | free credit |

Models are configured only in TrueForge, from `config/models.json` via `node scripts/setup-trueforge.mjs`;
**switching models is a config change plus rerunning setup** (or `scripts/use-models.sh openrouter-free`). Nemotron-3 Ultra was the
fastest with correct streamed tool calls among five NVIDIA models probed once each. **Real-model evidence** (one run each unless stated;
`docs/writeup/rehearsal.json`): finals code `0be9897`: **Task B 6/6, first diff 100.3 s, 216.8 s, 48 requests**, A 6/6, C 3/3, no
429; p14 `5710431`: B 6/6 twice (184 s, 203 s); 21 Nov hybrid build: B 6/6 in 3 of 3 runs on `f2f87bb`; tag `round1-submission`: A, B, C. TrueForge resends a 429'd request up to 4
times; then, before any write, auth errors fall back at once and other errors retry once, then fall back to the `-fallback`
agent in a fresh TrueForge session. **No retry or fallback after a write:** the turn ends, and a stop after writes (429, or no
output for 45 s, 120 s while a model request is in flight) offers **Resume** in the same TrueForge conversation (the fallback's, after a fallback; mock-tested, `c47e092`). The free
fallback shares NVIDIA's backend: it covers throttling and key problems, not an NVIDIA outage.

## 6. Scorecard

| Criterion (points) | What we show ([video] recording · [native test] VS Code UI tests · [harness rehearsal] `rehearsal.json`) | Video |
|---|---|---|
| Inline edit (10) | [video] Task A: selection → instruction → in-editor diff → hunk picker → accept → saved → verification `False`. [native test] choosing one hunk saves exactly that hunk | 00:03 |
| Agent mode (10) | [video] Task B: no files named; the agent finds and edits `cli.py`, `test_cli.py`, `docs/cli.rst`; the panel lists the changed files at turn end. [harness rehearsal] finals code `0be9897`: B 6/6 in 1 of 1 run (3 files, 6 reviews, 48 requests); `f2f87bb`: 3 of 3 | 00:52 |
| Streaming / cancellation (10) | [video] streamed text, context and tool calls. [native test] Stop during a pending review or a running command → cancelled, nothing applied; Stop after an approved edit reached VS Code → that edit is saved first | 00:40 |
| Context assembly (15) | [video] Context block: used/budget, ranked files with reasons, skipped items | 00:54 |
| Diff safety (10) | [video] hunk picker; Undo restores the file (`git status` empty). [native test] partial accept, undo after each hunk | 00:21 |
| Resilience (10) | [video] Task C: invalid primary key → fallback banner → ✕ (reject all hunks) → `git status` clean. [harness rehearsal] C passed (401 → OpenRouter) | 03:17 |
| TrueForge depth (10) | [video] Session view of Task B: the turn, its tool calls and approvals (deferred tools via `call_tool` only if the model uses them) | 03:05 |
| Demo video (10) | [video] Tasks A, B, C in order, each verified on screen | A 00:03 · B 00:52 · C 03:17 |
| PDF write-up (15) | This document (`docs/writeup/WRITEUP.pdf` in the repository); [video] the closing frame links the repository | 03:51 |

Timestamps: current video (first round-1 build); this build's multi-select hunk picker is covered by the native UI tests.
Automated checks use a **scripted model** that supplies Task B's paths and edits (plumbing, not discovery): `scripts/e2e-mock.sh`
(26 checks), `scripts/test-extension-e2e.sh` (A, B, Stop, C in VS Code), 205 unit, 26 integration (TrueForge 0.185.1) and 17 script tests;
responsiveness gates (host blocks ≤ 150 ms, webview renders ≤ 100 ms) pass 3/3 and fail an injected 200 ms stall.

## 7. Tools used

- **TrueForge 0.185.1** (agent harness), **TrueForge SDK**, **MCP TypeScript SDK**, VS Code extension API,
  TypeScript, Node.js, Python/pytest, `@vscode/test-electron`.
- **Demo video:** recorded by an automated UI script (Playwright over the Chrome DevTools Protocol) driving the
  real extension in VS Code with real models (NVIDIA primary, OpenRouter fallback) and the local TrueForge 0.185.1;
  no simulated output. Only model waiting time and operator holds were cut, each cut captioned on screen.
- **AI coding assistants (declared as required):** **Claude** (Anthropic; Claude Code CLI and Claude chat) —
  TrueForge spike, harness architecture and implementation, context engine, tests, and, after the hand-over,
  the editor workstream, documentation and this write-up draft. **OpenAI Codex (via ChatGPT)** — the initial
  VS Code extension scaffold, editor features (EditorPort, inline review, agent panel) and the shared
  contracts; PRs #3 and #4 (execution-safety sandbox for commands, tool-call settlement, retrieval coverage
  reporting, the submission-evidence checker); and a QA review of the 19 Nov build. All code was reviewed and
  directed by the team.

## 8. Known limitations and what you would do with another month

**Limitations.** Real-model behaviour was checked in a few runs with one model pair; Task B over-verifies and splits a file's
edits over several reviews, hence the harness budgets. Each step resends the whole conversation. Retrieval is lexical by default
(local embeddings opt-in); the symbol index covers Python only; weights were tuned on Flask. **`run_command` is write-protected,
not confidential:** bubblewrap hides the home directory and cuts the network, but workspace secrets are only caught by output
redaction; it needs Linux/WSL with bubblewrap. Free tiers limit Task B (NVIDIA throttled at 9–15 requests/min on 19 Nov;
OpenRouter's free fallback allows 50 requests/day; Groq's 7,000 tokens/min cannot take B). Compaction fires once in Task B,
usually after the first edit (once before it, first diff 100 s). Sub-agents are on by default; in 6 real runs Nemotron never
delegated, even when asked. Opt-in Daytona Code Mode sends files it reads to Daytona's cloud; edits stay in review. One
workspace folder; tested on WSL only.

**With another month:** faster embeddings and language-server symbols for retrieval, evaluated across repositories and
models; per-hunk CodeLens; conversation history across fallback; read confinement for
`run_command`; cost-aware model routing; Marketplace packaging.
