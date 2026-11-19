---
pdf_options:
  format: A4
  margin: 14mm 15mm
stylesheet: writeup.css
---

# Forge — a VS Code coding agent on TrueForge

Repository: https://github.com/riyajenson/forgeathon · Video: `<PUBLIC VIDEO URL>` · Techfest Team ID: `<TEAM ID>`

## 1. Team

`<Name 1>` (role, `<affiliation>`, GitHub `<handle>`) · `<Name 2>` (role, `<affiliation>`, GitHub `<handle>`) ·
`<Name 3>` (role, `<affiliation>`, GitHub `<handle>`)

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
TrueForge with allow/deny (the deny reason reaches the model). **Harness-enforced guardrails** (not left to
the prompt): a per-turn command budget (3 agent, 1 inline; later `run_command` calls are refused to the model
without prompting and the panel shows "command budget reached"), approved commands run in **bubblewrap** (read-only
checkout and host, private `/tmp`, no network, no provider keys in its environment; refused if unavailable;
it can still read files, see section 8), a tool still running after a
turn holds the session (no retry or fallback until it ends), and a second argument error on the same file gets
the exact `propose_edit` argument shape in its refusal.

**Editor tools are MCP tools** served by the harness inside the extension host (127.0.0.1, bearer token):
`gather_context`, `read_file`, `search_workspace`, `propose_edit`, `run_command`, and the **deferred**
`find_symbol` and `list_files` (loaded on demand through TrueForge's `call_tool`). Only `propose_edit` and
`run_command` require approval. TrueForge sends `x-tfg-session-id` on every MCP call, so an approval can be
used only by the tool call of the same session, once, with the same arguments.

**Diff safety.** `propose_edit` never writes by itself. The approved text (only accepted hunks) goes to the
editor's `applyText`, which checks the buffer hash, applies one `WorkspaceEdit`, saves, and returns one of six
outcomes (stale, approval missing, failed before apply, applied but unsaved, save failed, saved); undo is
guarded by the post-save hash and restores the exact original bytes (saved without save participants).

**Cancellation.** Stop closes the approval gate, cancels the TrueForge turn, kills a running command's
process group and closes the open review; an approved command never starts after Stop. `done` waits (bounded) for in-flight tool calls, because TrueForge 0.185.1 reports the turn
cancelled before an MCP call returns. Waits on TrueForge are bounded: if it stays silent, the harness stops
observing after twice the cancel timeout and ends the turn exactly once. A tool still running when the turn
ends is waited for until it finishes (the command timeout, at most 600 s, or Stop). Retry and fallback happen only when
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
5. **One read policy for every source** (retrieval, `@file`, `@symbol`, selection, active file, and the
   `read_file`, `search_workspace`, `list_files`, `find_symbol`, `gather_context` tools): credentials-shaped
   files (`.env*`, keys, `.netrc`, …) are never sent and are reported as skipped or refused; files with NUL bytes
   are refused; `read_file` returns at most 600 lines / 60,000 characters with lines cut at 2,000, each cut
   marked. Detection is by file name only.

Measured on Flask 3.1.3 (index + rank ≈ 0.2–0.3 s): for Task B, `src/flask/cli.py` ranks first and the
packed context (7,456 of 8,000 tokens, 28 items, 7 skipped) includes `tests/test_cli.py` and `docs/cli.rst`.
Four unrelated Flask tasks also rank their source file first (regression test in the repo).

## 5. Model setup

| Role | Model | Hosting | Approx. cost for the demo |
|---|---|---|---|
| Primary | `nvidia/nemotron-3-ultra-550b-a55b` | NVIDIA API Catalog, free tier | $0 |
| Fallback | `qwen/qwen3.8-27b` (different provider) | Groq, free tier | $0 |
| Spare (configured, unused) | `nvidia/nemotron-3-ultra-550b-a55b:free` | OpenRouter, free model | $0 |

Models are configured only in TrueForge, from `config/models.json` via `node scripts/setup-trueforge.mjs`;
**switching models is a config change plus rerunning setup**. The NVIDIA catalog offered no Qwen3 Coder or
DeepSeek model; tests use a local scripted model. Probed only (one request each): Kimi K3.1 Pro, GLM-5.3 Flash, Step-5, Mistral
Large 4, MiniMax M3.1 Flash; Nemotron-3 Ultra was the fastest with correct streamed tool calls. Gemini,
Anthropic and OpenAI appear in the example config only and were never run. **Rehearsal on the final build**
(`docs/writeup/rehearsal.json`, video settings): **A** passed, first diff 7.8 s, 3 requests, 11.3k / 0.7k
tokens; **C** passed, NVIDIA 401 → Groq, first diff 2.0 s; **B did not pass**: NVIDIA answered 429 at 9–15
requests/min (section 8); earlier B runs passed in 133–259 s. Failure policy: authentication errors fall back immediately; unreachable/timeouts/5xx/429
retry once (429 waits for the provider's `Retry-After` hint, capped at 30 s) and then fall back to the
`-fallback` agent in a new TrueForge session; nothing is retried after the turn changed the workspace. A
watchdog stops a turn that streams nothing for 45 s. Every turn is logged (model, attempts, tokens, timing; no
content) to `~/.forge/turns.jsonl`.

## 6. Scorecard

| Criterion (points) | What we show | Video |
|---|---|---|
| Inline edit (10) | Task A: selection → instruction → in-editor diff → Accept All / per-hunk → saved → verification `False` | `[mm:ss]` |
| Agent mode (10) | Task B: no files named; agent finds and edits `cli.py`, `test_cli.py`, `docs/cli.rst` | `[mm:ss]` |
| Streaming / cancellation (10) | Streamed text and tool calls; Stop → turn cancelled, no edits (Stop during a pending review and during a running command: UI e2e) | `[mm:ss]` |
| Context assembly (15) | Context block: used/budget, ranked files with reasons, skipped items | `[mm:ss]` |
| Diff safety (10) | Per-hunk picker, Undo restores the file, re-apply; partial accept (exactly the chosen hunk saved) in the native UI test | `[mm:ss]` |
| Resilience (10) | Task C: invalid primary key → fallback banner → `git status` clean | `[mm:ss]` |
| TrueForge depth (10) | Session view of Task B: the turn, its tool calls and approvals (deferred tools via `call_tool` when the model uses them) | `[mm:ss]` |
| Demo video (10) | Tasks A, B, C in order, each verified on screen | A `[mm:ss]` · B `[mm:ss]` · C `[mm:ss]` |
| PDF write-up (15) | This document; the video's closing frame links the repository | `[mm:ss]` |

Automated checks use a **scripted model**: they show that the plumbing works, not that a real model solves
the tasks. `scripts/e2e-mock.sh` runs A, B, C and the guardrails through the harness with every verification
(21 checks); `scripts/test-extension-e2e.sh` drives A (with undo), B, Stop (during a pending review and during a
running command) and C through the extension in a real VS Code window; a native-UI test checks that the hunk
picker saves exactly the chosen hunk; the extension host is never blocked over 150 ms during Task B. Harness:
130 unit tests and 17 integration tests against TrueForge 0.185.1.

## 7. Tools used

- **TrueForge 0.185.1** (agent harness), **TrueForge SDK**, **MCP TypeScript SDK**, VS Code extension API,
  TypeScript, Node.js, Python/pytest, `@vscode/test-electron`.
- **AI coding assistants (declared as required):** **Claude** (Anthropic; Claude Code CLI and Claude chat) —
  TrueForge spike, harness architecture and implementation, context engine, tests, and, after the hand-over,
  the editor workstream, documentation and this write-up draft. **OpenAI Codex (via ChatGPT)** — the initial
  VS Code extension scaffold, editor features (EditorPort, inline review, agent panel) and the shared
  contracts; PRs #3 and #4 (execution-safety sandbox for commands, tool-call settlement, retrieval coverage
  reporting, the submission-evidence checker); and a QA review of the final build. All code was reviewed and
  directed by the team.

## 8. Known limitations and what you would do with another month

**Limitations.** Development and automated tests used a scripted model; real-model behaviour was checked in
a few runs with one model pair. In Task B the real model over-verified (7–17 commands) and split edits to one
file over several reviews even with instructions against both, hence the harness command budget (3 commands
in the measured run; `cli.py` still took 3 reviews); each step resends the whole conversation, so token use grows with the number of
steps. An optional setting auto-approves bare `pytest`/`git status|diff` only. Retrieval is lexical (no embeddings) and
the symbol index covers Python only; ranking weights were tuned on Flask. A fallback starts a new TrueForge
session, so it does not see earlier panel turns. **`run_command` is write-protected, not confidential:** bubblewrap
makes the checkout read-only and cuts the network, but an approved command can read any file you can; it needs
Linux/WSL with bubblewrap (otherwise commands are refused), and tests that write into the tree or need the
network fail by design. Free tiers limit Task B: in the final rehearsal NVIDIA throttled at 9–15 requests/min
(no `Retry-After`), and Groq's free tier (7,000 input tokens/min) cannot take B's ~11k-token requests, so the
fallback covers short turns like C but not B. Compaction is configured but the
demo tasks never reach the threshold. Hunk review uses a picker rather than per-hunk CodeLens. One workspace
folder; tested on WSL only.

**With another month:** embeddings and language-server symbols for retrieval, evaluated on a task suite
across several repositories and models; per-hunk CodeLens and streaming diff previews; resuming conversation
history after fallback; a confidentiality boundary for `run_command` (read access limited to the workspace); cost-aware model routing; packaging for the Marketplace.
