# Harness handoff — 2026-11-19 01:00 IST

Working copy: `~/projects/forgeathon` (WSL). Nothing has been pushed. Every branch below builds; its tests
pass; the tree is clean (only the editor's untracked `extension/` is present, untouched).

## 1. Branches

| Branch | Base | Contents | Tests at its tip |
|---|---|---|---|
| `docs/branching` | none (root commit; `main` is unborn) | `docs/BRANCHING.md` | n/a |
| `contracts/v0.4.0` | none (root commit) | `contracts/` exactly as synced by the editor (R1–R5, PROTOCOL_VERSION 0.4.0), byte-identical, verified with `cmp` | `tsc -p contracts` clean |
| `harness/p0-spike` | none (root) | P0 spike + `spike/FINDINGS.md` | n/a (spike) |
| `harness/p1-review-mcp` | `harness/p0-spike` | review core, MCP server (read_file, search_workspace, propose_edit) | 27 unit |
| `harness/p2a-turn-runner` | `harness/p1-review-mcp` | turn runner, `createHarness`, session scoping, apply outcomes, run_command | 37 unit, 14 integration |
| `harness/p3-agents-setup` | `harness/p2a-turn-runner` | agent templates, setup script, example config | 42 unit, 16 integration |
| `harness/p4-context-engine` | `harness/p3-agents-setup` + merge of `contracts/v0.4.0` | context engine, `gather_context`, `context_report`, types imported from `contracts/` | **50 unit, 16 integration** |

**Use `harness/p4-context-engine` for editor integration.** It is the only harness branch that imports
`contracts/` (0.4.0); p2a/p3 still carry the earlier local mirror and report protocol 0.3.0.

Commits (oldest last within each branch; P0 and P1 subjects predate the `<area>: <summary>` convention and were not rewritten):

- `docs/branching`: 7dba56d docs: add shared branching and commit convention
- `contracts/v0.4.0`: 3f2fa5d contracts: add shared integration contracts v0.4.0
- `harness/p0-spike`: be6ca4d, 6f6515b, 08903ab, 3465f70, d7e324c, 9af1f28
- `harness/p1-review-mcp`: 61128c2, 84e79ed, 29ff576, eb207a6, a2ebb64, c7d059a, 0a413b5, 69defc5, fdbc4f0, cfc670b
- `harness/p2a-turn-runner`:
  fc6309d test: cover run_command and model-added argument keys ·
  f7060ee harness: add approved run_command with git change detection ·
  9cec5dc harness: bind approvals to the tools' declared fields only ·
  6d711b8 docs: mark v0.2 harness requirements as superseded by contracts ·
  c31c322 test: cover turns end to end against TrueForge 0.185.1 ·
  65aaf17 test: add scripted mock model and slow-apply hooks for integration ·
  b3e5759 harness: implement createHarness over TrueForge sessions and MCP server ·
  7c56513 harness: orchestrate reviews, retry and fallback for one turn ·
  9fdff19 harness: add replayable turn event buffer, tool mapping and prompt input ·
  8efd27a harness: add TrueForge turn attempt with approval round trip and cancel ·
  9333ff3 harness: load TrueForge SDK via ESM import and classify turn errors ·
  ebc72ac harness: add package entry point with editor bridge and harness API ·
  8fbaf2a, d43ad23, aa629fa, 1879392, 4bee157, a59e473, a92f772 (MCP rework for session scoping and R1–R5)
- `harness/p3-agents-setup`:
  73f8596 test: cover setup builders and a headless inline-edit rehearsal ·
  e913a2d scripts: add setup-trueforge launcher and CLI ·
  16d648a harness: add idempotent TrueForge setup with fallback agent variants ·
  a8a7c7c harness: add example model config and ignore local models.json ·
  61bdd54 agent: add forge-coder and forge-inline agent templates
- `harness/p4-context-engine`:
  (this handoff file) ·
  73e283c harness: import shared types from contracts v0.4.0 ·
  4ace83b harness: locate the repository root instead of fixed relative paths ·
  da402f1 harness: merge contracts v0.4.0 ·
  cbb7bf5 test: cover context engine and context_report in turns ·
  062ed90 harness: add gather_context tool and preload it for forge-coder ·
  09a229e harness: assemble context before each turn and emit context_report ·
  1fe97e6 harness: pack pinned and retrieved context within a token budget ·
  e2771f6 harness: rank files with BM25, symbol/path boosts and test/doc pairing ·
  6f8115f harness: index workspace chunks, Python symbols and imports ·
  2e22e05 harness: add identifier-aware tokenising, file filtering and code chunking

Integration tests (real TrueForge 0.185.1 + scripted mock model), all passing: allow · partial accept ·
deny (reason reaches the model) · duplicate identical calls in one step · cancel while paused · cancel while
streaming (confirmed < 2 s) · cancel racing an in-flight apply (write reported before `done`) · 401 →
immediate fallback · refused → one retry → fallback · fallback also fails → clear error · error after a
write → no retry/fallback · watchdog → retry → fallback · model-added argument keys · run_command with
changed-file report · setup idempotent from the real templates · headless Task A inline rehearsal.

## 2. Push and merge order

Push (any order; nothing depends on remote state):

```bash
cd ~/projects/forgeathon
git push origin docs/branching contracts/v0.4.0 harness/p0-spike harness/p1-review-mcp \
  harness/p2a-turn-runner harness/p3-agents-setup harness/p4-context-engine
```

Merge into `main` (rehearsed in a scratch clone: no conflicts; the result equals
`harness/p4-context-engine` plus `docs/BRANCHING.md`). `main` has no commits yet, so the first merge
just creates it, and the root-commit branches need `--allow-unrelated-histories`:

```bash
git switch --orphan main            # only if main is still unborn in this worktree
git merge docs/branching
git merge --no-ff --allow-unrelated-histories contracts/v0.4.0
git merge --no-ff --allow-unrelated-histories harness/p1-review-mcp   # brings harness/p0-spike too
git merge --no-ff harness/p2a-turn-runner
git merge --no-ff harness/p3-agents-setup
git merge --no-ff harness/p4-context-engine
git push origin main
```

Do the merges in a worktree where `main` can be checked out (the harness worktree has
`harness/p4-context-engine` checked out). Afterwards I delete the merged local harness branches and merge
`main` into my next branch.

## 3. Wiring `createHarness` in the extension

Build and link once:

```bash
npm --prefix src/harness ci && npm --prefix src/harness run build
# extension/package.json: "dependencies": { "forge-harness": "file:../src/harness" }, then npm install in extension/
```

Never `require('@truefoundry/trueforge-sdk')` directly (its CommonJS build is broken); the harness loads
it internally. No bundler is needed for the Extension Development Host.

```ts
import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { createHarness, PROTOCOL_VERSION, type EditorPort, type HarnessEvent } from 'forge-harness';

const req = <T>(body: T) => ({ version: PROTOCOL_VERSION, requestId: randomUUID(), body });

export async function activate(context: vscode.ExtensionContext) {
  const cfg = vscode.workspace.getConfiguration('forge');
  const port: EditorPort = makeEditorPort(); // readText (dirty buffer first), listFiles, applyText (six outcomes), log
  const harness = createHarness({
    trueforgeUrl: cfg.get('trueforgeUrl', 'http://127.0.0.1:8790'),
    mcpPort: cfg.get('mcpPort', 47615),
    contextBudgetTokens: cfg.get('context.budgetTokens', 8000),
  });
  await harness.start(port); // throws a readable Error if TrueForge is down or not allowlisted
  context.subscriptions.push({ dispose: () => void harness.dispose() });

  const root = vscode.workspace.workspaceFolders![0]!.uri.fsPath;
  const s = await harness.createSession(req({ workspaceRoot: root }));
  if (!s.ok) throw new Error(s.error.message);
  const sessionId = s.body.sessionId;

  // One turn (inline example).
  const turnId = randomUUID();
  const sub = await harness.submitTurn(req({
    sessionId, turnId, mode: 'inline' as const, instruction,
    selection: { path: relPath, startLine, endLine, text: selectedText },
  }));
  if (!sub.ok) return show(sub.error);
  for await (const r of harness.stream(req({ sessionId, turnId, afterSequence: 0 }))) {
    if (!r.ok) { show(r.error); break; }
    const e: HarnessEvent = r.body;
    switch (e.t) {
      case 'review_request': /* show diff of e.proposal; on decision: */
        await harness.submitReview(req({ sessionId, turnId, callId: e.proposal.callId, kind: 'edit' as const,
          proposalId: e.proposal.proposalId, hunks: { /* every hunkId → 'accept' | 'reject' */ } }));
        break;
      case 'command_request':
        await harness.submitReview(req({ sessionId, turnId, callId: e.callId, kind: 'command' as const, allow: true }));
        break;
      case 'done': /* close review UI; e.status is done | cancelled | error */ break;
      // also: session (traceUrl), status, text, tool_call, tool_result, context_report, edit_applied, fallback, error
    }
  }
  // Cancel button: (await harness.cancel(req({ sessionId, turnId }))).body → 'confirmed' | 'already_terminal' | 'unconfirmed'
}
```

The edit is written only through `port.applyText` while TrueForge executes the approved `propose_edit`,
with `text` (the exact reviewed result), `textSha256`, `expectedSha256` and the accepted hunk IDs. The UI
must not write on "accept".

## 4. Start TrueForge and run setup

```bash
cd ~/projects/forgeathon
npm --prefix src/harness ci && npm --prefix src/harness run build

# Terminal 1 — TrueForge (local mode). Use a fresh database for the demo.
mkdir -p ~/forge-demo
OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1"]' MODEL_HTTP_CONNECT_TIMEOUT_MS=3000 MODEL_HTTP_MAX_RETRIES=1 \
  SQLITE_PATH=$HOME/forge-demo/tf.sqlite npx -y @truefoundry/trueforge@0.185.1
# UI and Sessions page: http://localhost:8790

# Terminal 2 — models, connector, agents (idempotent; rerun after editing the config)
cp config/models.example.json config/models.json     # pick primary + fallback (different providers)
export ANTHROPIC_API_KEY=...  OPENAI_API_KEY=...     # names as given in apiKeyEnv; never in files
node scripts/setup-trueforge.mjs                     # --dry-run prints the plan with keys redacted
```

Tests: `npm --prefix src/harness test` (unit) and, with TrueForge running on 8790,
`npm --prefix src/harness run test:integration` (uses its own mock model; creates `it-*`/`setup-*`
test providers and agents in that TrueForge database, so do not point it at the demo database).

## 5. P4 status (context engine)

Implemented: text-file walk (.gitignore, build/vendor dirs, size and binary skips) · Python
def/class/decorator chunks and symbol table · doc sections · one-hop imports · BM25 over split
identifiers · symbol, decorator and file-name boosts · neighbour bonuses (src/x.py ↔ tests/test_x.py,
docs mentioning the module or its symbols, imports) · changelog down-weighting · packing within the
budget (pinned selection, @symbol, @file, active-file outline; then outlines; then whole functions) ·
`ContextReport` with ranks, plain-English reasons and skipped items · `context_report` emitted once per
turn before the TrueForge session, and again for each `gather_context` call.

Flask 3.1.3, Task B instruction, budget 8000 (186 ms, 7281 tokens used), top of the ranking:

| # | File | Score | Main reasons |
|---|---|---|---|
| 1 | docs/cli.rst | 116.6 | matches command/built/help/cli; file name "cli"; documents src/flask/cli.py |
| 2 | docs/config.rst | 111.8 | matches configuration/key/config/secret; file name "config" |
| 3 | tests/test_config.py | 104.6 | matches key/secret/config/json |
| 4 | tests/test_cli.py | 94.8 | matches command/cli; tests for src/flask/cli.py |
| 5 | src/flask/cli.py | 88.4 | matches command/built/loaded/cli/help; defines FlaskGroup.list_commands, run_command |
| 6 | docs/api.rst | 87.5 | documents src/flask/cli.py (mentions flask.cli, run_command, FlaskGroup) |
| 7 | src/flask/sansio/app.py | 74.1 | matches key/config/json/application |
| 8 | src/flask/config.py | 72.9 | defines Config.from_object, from_envvar |

All four expected files are in the top 6 and in the packed context.

Left for P4 / later:
- `src/flask/cli.py` ranks #5, not #1; tune with a real model run (the agent also has `gather_context` and search).
- Enrich with editor symbols (would need a bridge method; not in the contract — use the built-in Python index for now).
- Cache the index across turns (each turn re-reads the workspace, ~200 ms on Flask).
- Deferred tools `find_symbol` and `list_files` (P6) are not implemented; the agent templates do not reference them.
- README harness section and write-up notes (P6).

## 6. Known issues and risks

- **No real model has been run yet** (no API keys used). Everything above ran against the scripted mock.
  Built-in provider naming (`anthropic/<model>`, `openai/<model>`) is assumed from the custom-provider
  behaviour; the setup script warns if TrueForge does not list the configured models.
- TrueForge model and provider names must match `^[a-z][a-z0-9-]{0,62}[a-z0-9]$` (verified: dots are
  rejected); put the real model id in `modelId`.
- TrueForge 0.185.1 reports `turn.done(cancelled)` before an in-flight MCP call returns; the harness holds
  its own `done` until in-flight tool calls settle (10 s cap) and reports any write that happened.
- Watchdog default is 45 s without any TrueForge event; a silent reasoning model could trip it
  (configurable via `watchdogMs`).
- A fallback runs in a new TrueForge session, so it does not see earlier agent-panel turns (accepted limitation).
- `run_command` can change files outside review; every run counts as a write (no retry/fallback after it)
  and its changed files are reported from `git status --porcelain` before/after.
- Compaction events are mapped to `status: compacting` but have not been observed at runtime.
- Extension-host Node version under Remote-WSL is still unreported (`import()` needs Node ≥ 18).
- `~/forge-dev` holds the scratch TrueForge database used by my integration runs; it can be deleted.

## 7. Decisions made

1. `contracts` branch named `contracts/v0.4.0` (the file's actual version, per the `contracts/v<semver>`
   convention) rather than `contracts/v0.3.x`; created as a root commit because `main` is unborn, same for
   `docs/branching`.
2. Merged `contracts/v0.4.0` only into `harness/p4-context-engine` (the active branch); p2a/p3 keep the
   earlier mirror so their history is unchanged.
3. Approval keys hash only each tool's declared fields: the MCP server strips undeclared keys before the
   handler runs, so hashing raw model arguments would fail closed on harmless extra keys (found and tested).
4. Context is assembled by the harness before every turn (agent budget 8000, inline 2500) and appended to
   the user message, so a `context_report` always appears even if the model never calls `gather_context`.
5. Ranking weights: decayed sum of a file's top chunks + term coverage, ×1.3 for code files, neighbour
   bonuses take the best source (not the sum), changelogs ×0.3, single chunks capped at 15% of the budget.
6. `config/.gitignore` ignores `config/models.json` (kept inside the harness-owned `config/` folder instead
   of adding a root `.gitignore`).
7. Example config model names: `claude-sonnet-5-5` (anthropic) primary, `gpt-5-2` (openai, modelId
   `gpt-5.2`) fallback — placeholders until you choose the real models.
8. The harness build output moved to `dist/src/harness/` (needed to compile `contracts/`); the package
   `main`/`types` point there, so consumers importing `forge-harness` are unaffected.
