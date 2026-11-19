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
guarded by the post-save hash and restores the exact original bytes (saved without save participants).

**Cancellation.** Stop closes the approval gate, cancels the TrueForge turn (confirmed in 10–25 ms in our
spike), kills a running command's process group and closes the open review; an approved command never starts
after Stop. `done` waits (bounded) for in-flight tool calls, because TrueForge 0.185.1 reports the turn
cancelled before an MCP call returns. Every wait is bounded: if TrueForge stays silent, the harness stops
observing after twice the cancel timeout and ends the turn exactly once. Retry and fallback happen only when
every tool call of the failed attempt has settled and no approved edit or command is unfinished.

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
| Primary | `nvidia/nemotron-3-ultra-550b-a55b` | NVIDIA API Catalog, free tier | $0 |
| Fallback | `qwen/qwen3.8-27b` (different provider) | Groq, free tier | $0 |
| Spare (configured, unused) | `nvidia/nemotron-3-ultra-550b-a55b:free` | OpenRouter, free model | $0 |
| Development and tests | scripted demo model (`scripts/dev-mock.sh`) | local, no LLM | $0 |

Models are configured only in TrueForge, from `config/models.json` via `node scripts/setup-trueforge.mjs`;
**switching models is a config change plus rerunning setup**. The NVIDIA catalog offered no Qwen3 Coder or
DeepSeek model; Nemotron-3 Ultra was the fastest candidate that made correct streamed tool calls in our
probes. Real run on a fresh TrueForge database (2026-11-19, each task once, all checks passed, no 429s;
requests counted by `scripts/model-meter.mjs`): **Task A** 3 requests, 11.4k input / 0.6k output tokens,
8.5 s; **Task C** 401 from NVIDIA in 0.19 s → Groq, 3 requests, 6.8k / 0.4k tokens, 2.6 s; **Task B** 49
requests, 1.62M / 7.5k tokens, 133 s (48 tool calls, 15 commands, 7 reviews over 4 files). Failure policy: authentication errors fall back immediately; unreachable/timeouts/5xx/429
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
| TrueForge depth (10) | Session view of Task B: the turn, its tool calls and approvals (deferred tools via `call_tool` when the model uses them) | `[mm:ss]` |
| Demo video (10) | Tasks A, B, C in order, each verified on screen | — |
| PDF write-up (15) | This document | — |

Automated checks use a **scripted model**, so they show that the plumbing works, not that a real model
solves the tasks. Without a GUI or keys: `scripts/e2e-mock.sh` (15/15 checks: Task A one-liner and docstring,
`pytest tests/test_cli.py -q` 57 passed, `flask --help` lists `config`, masked JSON, Task C fallback + clean
status); in a real VS Code window: `scripts/test-extension-e2e.sh` (Tasks A, B, Stop, C through the extension
code) and 4 extension suites. Harness: 83 unit tests (including cancel and retry races against an in-memory
TrueForge stand-in) and 17 integration tests against TrueForge 0.185.1.

## 7. Tools used

- **TrueForge 0.185.1** (agent harness), **TrueForge SDK**, **MCP TypeScript SDK**, VS Code extension API,
  TypeScript, Node.js, Python/pytest, `@vscode/test-electron`.
- **AI coding assistants (declared as required):** **Claude** (Anthropic; Claude Code CLI and Claude chat) —
  TrueForge spike, harness architecture and implementation, context engine, tests, and, after the hand-over,
  the editor workstream, documentation and this write-up draft. **OpenAI Codex (via ChatGPT)** — the initial
  VS Code extension scaffold, editor features (EditorPort, inline review, agent panel) and the shared
  contracts. All code was reviewed and directed by the team.

## 8. Known limitations and what you would do with another month

**Limitations.** Development and automated tests used a scripted model; real-model behaviour was checked in
one run per task with one model pair. In Task B the real model over-verified (15 commands, each needing
approval, including a docs build and full test suite) and split edits to one file over several reviews; each
step resends the whole conversation, so token use grows with the number of steps. Retrieval is lexical (no embeddings) and
the symbol index covers Python only; ranking weights were tuned on Flask. A fallback starts a new TrueForge
session, so it does not see earlier panel turns. **`run_command` is not sandboxed:** an approved command can
change any file you can, without hunk review. Mitigations: one-use approval of the exact command, an
"Unrestricted" warning for anything beyond pytest/`python -c`/`flask`/`git status|diff`, workspace-confined
cwd, credential-like variables withheld, timeout and output cap, and a `git status` diff reported as "changed
outside review" (it cannot see ignored files or paths outside the workspace). Compaction is configured but the
demo tasks never reach the threshold. Hunk review uses a picker rather than per-hunk CodeLens. One workspace
folder; tested on WSL only.

**With another month:** embeddings and language-server symbols for retrieval, evaluated on a task suite
across several repositories and models; per-hunk CodeLens and streaming diff previews; resuming conversation
history after fallback; a sandboxed `run_command`; cost-aware model routing; packaging for the Marketplace.
