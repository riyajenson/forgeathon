---
pdf_options:
  format: A4
  margin: 14mm 15mm
stylesheet: writeup.css
---

# Forge — a VS Code coding agent on TrueForge

Repository: `<PUBLIC REPO URL>` · Video: `<PUBLIC VIDEO URL>` · Techfest Team ID: `<TEAM ID>`

## 1. Team

`<Name 1>` (role) · `<Name 2>` (role) · `<Name 3>` (role)

## 2. Starting point

Built **from scratch**; not a fork of any editor or agent. The first commit is a TrueForge 0.185.1 feasibility
spike (`spike/FINDINGS.md`); the VS Code extension was scaffolded from an empty folder. TrueForge itself is
used unmodified as the harness (`npx @truefoundry/trueforge@0.185.1`, local mode, SQLite).

## 3. Architecture on TrueForge

![Architecture](architecture.svg)

**TrueForge owns the agent loop.** Two agent definitions live in the repo (`agent/forge-inline.json`,
`agent/forge-coder.json`); the setup script registers them with the primary model and generates
`-fallback` variants with the fallback model. Subagents, generative UI, ask-user and the sandbox are off;
compaction is on (60k input tokens); iteration limits 8 (inline) and 60 (agent).

**Harness (`forge-harness`).** Maps each editor turn to a TrueForge session/turn via the TrueForge SDK
(`createTurnStream`, `subscribeToTurn`, `createTurnEvents`, `sessions.cancel`), normalises the event stream
(text, tool calls, results, context report, review/command requests, fallback, done) and handles approvals:
on `tool.approval_required` it computes the hunks, waits for the user's per-hunk decision and answers
TrueForge with allow/deny (the deny reason reaches the model).

**Editor tools are MCP tools** served by the harness inside the extension host (127.0.0.1, bearer token):
`gather_context`, `read_file`, `search_workspace`, `propose_edit`, `run_command`, and the **deferred**
`find_symbol` and `list_files` (loaded on demand through TrueForge's `call_tool`). Only `propose_edit` and
`run_command` require approval. TrueForge sends `x-tfg-session-id` on every MCP call, so an approval can be
used only by the tool call of the same session, once, with the same arguments.

**Diff safety.** `propose_edit` never writes by itself. The approved text (only accepted hunks) goes to the
editor's `applyText`, which checks the buffer hash, applies one `WorkspaceEdit`, saves, and returns one of six
outcomes (stale, approval missing, failed before apply, applied but unsaved, save failed, saved); undo is
guarded by the post-save hash.

**Cancellation.** Stop closes the approval gate, cancels the TrueForge turn (confirmed in 10–25 ms in our
spike), kills a running command and closes the open review; `done` is held until in-flight tool calls settle
because TrueForge 0.185.1 reports the turn cancelled before an MCP call returns (found in the spike).

## 4. How context is selected

1. **Pinned first:** the selection, `@symbol:Name` (resolved through a Python def/class index),
   `@file:path`, and an outline of the active file.
2. **Automatic retrieval:** the workspace is chunked (functions/classes with decorators, doc sections),
   identifiers are split (`routes_command` → `routes`, `command`), and chunks are scored with BM25 plus
   symbol-name, decorator and file-name boosts. A file's score sums its best chunks and term coverage; code
   is weighted above docs and tests, which then rise through **neighbour bonuses**: `src/x.py` →
   `tests/test_x.py`, docs that mention the module or its symbols, and one-hop imports.
3. **Packing within the budget** (default 8,000 tokens, chars/4): outlines of the top files, then whole
   functions and sections; anything that does not fit is listed as **skipped** with the reason.
4. The **context report** (items, ranks, plain-English reasons, used/budget, skipped) is shown in the agent
   panel; the agent can ask for more with `gather_context`.

Measured on Flask 3.1.3 (index + rank ≈ 0.2–0.3 s): for Task B, `src/flask/cli.py` ranks first and the
packed context (7,456 of 8,000 tokens, 28 items, 7 skipped) includes `tests/test_cli.py` and `docs/cli.rst`.
Four unrelated Flask tasks also rank their source file first (regression test in the repo).

## 5. Model setup

| Role | Model | Hosting | Approx. cost for the demo |
|---|---|---|---|
| Primary | `<provider/model>` | `<provider API>` | `<$ … >` |
| Fallback | `<provider/model>` (different provider) | `<provider API>` | `<$ … >` |
| Development and tests | scripted demo model (`scripts/dev-mock.sh`) | local, no LLM | $0 |

Models are configured only in TrueForge, from `config/models.json` (examples for Gemini, Groq, OpenRouter,
Anthropic and OpenAI) via `node scripts/setup-trueforge.mjs`; **switching models is a config change plus
rerunning setup**. Failure policy: authentication errors fall back immediately; unreachable/timeouts/5xx/429
retry once (429 waits for the provider's `Retry-After` hint, capped at 30 s) and then fall back to the
`-fallback` agent in a new TrueForge session; nothing is retried after the turn changed the workspace. A
watchdog stops a turn that streams nothing for 45 s. Every turn is logged (model, attempts, tokens, timing; no
content) to `~/.forge/turns.jsonl`. Measured with TrueForge 0.185.1: invalid key → error in 0.06–0.1 s;
refused connection 0.1–0.2 s; unreachable host 7.6 s (connect timeout 3 s, one HTTP retry).

## 6. Scorecard

| Criterion (points) | What we show | Video |
|---|---|---|
| Inline edit (10) | Task A: selection → instruction → in-editor diff → Accept All / per-hunk → saved → verification `False` | `[mm:ss]` |
| Agent mode (10) | Task B: no files named; agent finds and edits `cli.py`, `test_cli.py`, `docs/cli.rst` | `[mm:ss]` |
| Streaming / cancellation (10) | Streamed text and tool calls; Stop during review → turn cancelled, no edits | `[mm:ss]` |
| Context assembly (15) | Context block: used/budget, ranked files with reasons, skipped items | `[mm:ss]` |
| Diff safety (10) | Per-hunk review, partial accept, undo | `[mm:ss]` |
| Resilience (10) | Task C: invalid primary key → fallback banner → `git status` clean | `[mm:ss]` |
| TrueForge depth (10) | Session view: turns, tool calls, approvals, deferred `find_symbol` via `call_tool` | `[mm:ss]` |
| Demo video (10) | Tasks A, B, C in order, each verified on screen | — |
| PDF write-up (15) | This document | — |

Verification without a GUI or keys: `scripts/e2e-mock.sh` (15/15 checks: Task A one-liner, `pytest
tests/test_cli.py -q` 57 passed, `flask --help` lists `config`, masked JSON, Task C fallback + clean status);
in a real VS Code window: `scripts/test-extension-e2e.sh` (Tasks A, B, Stop, C through the extension code).
Harness: 55 unit + 17 integration tests against TrueForge 0.185.1.

## 7. Tools used

- **TrueForge 0.185.1** (agent harness), **TrueForge SDK**, **MCP TypeScript SDK**, VS Code extension API,
  TypeScript, Node.js, Python/pytest, `@vscode/test-electron`.
- **AI coding assistants (declared as required):** **Claude** (Anthropic; Claude Code CLI and Claude chat) —
  TrueForge spike, harness architecture and implementation, context engine, tests, and, after the hand-over,
  the editor workstream, documentation and this write-up draft. **OpenAI Codex (via ChatGPT)** — the initial
  VS Code extension scaffold, editor features (EditorPort, inline review, agent panel) and the shared
  contracts. All code was reviewed and directed by the team.

## 8. Known limitations and what you would do with another month

**Limitations.** `<Update after the real-model rehearsal.>` Development and automated tests used a scripted
model; real-model behaviour was checked only in `<n>` rehearsals. Retrieval is lexical (no embeddings) and
the symbol index covers Python only; ranking weights were tuned on Flask. A fallback starts a new TrueForge
session, so it does not see earlier panel turns. `run_command` runs with approval but can change files outside
the diff review (changes are reported from `git status` and count as writes). Compaction is configured but the
demo tasks never reach the threshold. Hunk review uses a picker rather than per-hunk CodeLens. One workspace
folder; tested on WSL only.

**With another month:** embeddings and language-server symbols for retrieval, evaluated on a task suite
across several repositories and models; per-hunk CodeLens and streaming diff previews; resuming conversation
history after fallback; a sandboxed `run_command`; cost-aware model routing; packaging for the Marketplace.
