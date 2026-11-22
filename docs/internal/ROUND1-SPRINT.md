# Round 1 sprint: research triage (22 Nov 2026, 17:35 IST)

Sources: agent-loop (AL), command-security (CS), context-engine (CE), editor-side (ED), mcp-tools (MT), resilience (RS)
research reports, all audited at `babc29c`. Base for the sprint: main `28e8f9e` (tag `round1-extended-2`).
Branch: `sprint/round1-research`. Code stop 20:30 IST.

Ranking = value for judges × feasibility in this sprint, then (equal items) visible in the editor > improves safety >
fewer model requests per Task B. **Proof** says what can show the item works: offline (unit / integration on the real
TrueForge with the scripted model / mock e2e / VS Code UI suites) or real (needs real-model runs, so its benefit can
only be claimed after the 5a smoke or later campaigns). Risk is to Tasks A / B / C (L/M/H). Effort is the sprint scope
(often a narrower slice than the report's estimate, named in the scope column).

## Already done

| Item | Reports | Status |
|---|---|---|
| Resume bound to the stopped attempt's agent and TrueForge session (post-fallback Resume) | AL #1, RS §5, ED §10 | Done in `c47e092` (unit + integration on TrueForge: fallback writes, 429, Resume continues the fallback session) |

## Ranked list (de-duplicated)

| # | Item (sprint scope) | Reports | Value for judges | Effort | Risk A/B/C | Proof | Behaviour change → setting? |
|---:|---|---|---|---|---|---|---|
| 1 | **Verification outcome at turn end**: when a turn changed code and the last test run failed, is stale (edited after it) or never ran, the turn ends as "unverified" with a visible warning in the panel and in `done`, never as a plain success; contradiction with the model's reply is flagged | AL #2/§8, CS budget, ED §15 | High: safety + honesty, directly the failure seen in today's real B | 1.5 h | L/L/L | offline (unit, panel suite, mock e2e) | Reporting only; no loop change |
| 2 | **Write barrier across Resume**: a resumed turn inherits the "already wrote" state, so it never retries or falls back automatically, and a 429/stall offers Resume again | RS §2, AL §7 | High: safety invariant (zero replay) | 1 h | L/M/L | offline (unit + integration) | Recovery policy, safety-only; default on |
| 3 | **Content-aware secret redaction for outbound source**: credential-shaped strings (the redaction patterns already used for command output) are masked in `read_file`, `search_workspace`, context packs and selections before they reach the model or TrueForge traces; the context report says how many were masked | CS §secret-file (top security fix), MT §2 | High: closes a documented limitation | 2 h | L/L/L if no Flask hits (verify) | offline (unit, scan of Flask = 0 hits, mock e2e) | Setting `forge.context.redactSecrets`; default on only if Flask/e2e prove no effect |
| 4 | **Fallback recovery card**: one deduplicated card with previous → current model, reason, "fresh TrueForge session", workspace effect (no files changed / N files) | ED §11 | Medium-high: visible in Task C | 1 h | L/L/L (UI only) | offline (panel suite, UI e2e) | No |
| 5 | **Context report grouped by file and skip reason** (pins and budget first; per-file rows with ranges; skipped grouped by reason; full list on demand) | ED §12, CE §5 | Medium-high: Context assembly (15) is visible | 1.5 h | L/L/L (UI only) | offline (panel suite) | No |
| 6 | **Long Retry-After honoured for Resume** (harness parser cap of 30 s no longer hides a longer provider hint; Resume waits max(60 s, hint)) | RS baseline/§3, ED §10 | Medium: resilience correctness | 0.5 h | L/L/L | offline (unit) | No (only the suggested wait) |
| 7 | **Status-first error classification** (explicit transient status such as 429/503 wins over auth-like wording; 401/403 still fall back at once) | RS §1 | Medium: resilience | 0.75 h | L/L/M | offline (unit + integration C) | Classification fix; default on with tests |
| 8 | **Stop shows three states** (stop requested → settling: approved edit saving / command stopping → stopped) | ED §9, RS §6 | Medium: visible, truthful cancellation | 1 h | L/L/L | offline (panel + UI e2e Stop) | No |
| 9 | **Unrestricted-command prompt states two facts**: "outside the verification allowlist" and "sandbox: active (read-only, no network)" + reason | ED §16 | Medium: visible safety | 0.5 h | L/L/L | offline (extension suite) | No |
| 10 | **Multi-range `read_file`** (`ranges: [{start_line,end_line}]`, deduplicated, one base hash, per-range omissions) | AL #3/§6, MT §2 | Medium: fewer requests per B (unproven) | 2 h | L/M/L | offline for correctness; **real** for request savings | Setting `forge.tools.multiRangeRead`, default off |
| 11 | **Resume when ready** (opt-in one-shot scheduled Resume; cancelled by Stop, new turn or conversation change) | ED §10 (rank 1), RS §5 | Medium: visible, removes the return visit | 1 h | L/L/L | offline (panel suite) | User opt-in per click |
| 12 | **File/symbol multi-select attach picker** (QuickPick `canSelectMany` → `@file:`/`@symbol:` mentions) | ED §5/§4 | Medium: visible context control | 1.5 h | L/L/L | offline (extension suite) | No |
| 13 | **Effective settings command** (status/command palette entry listing effective Forge settings and when each applies) | ED §17 | Low-medium: visible | 0.75 h | L/L/L | offline (extension suite) | No |
| 14 | **`propose_edit` no-match hints** (nearest matching line and current text in the refusal) | AL §2, ED §7, MT §4 | Medium: fewer repair requests (unproven) | 1.5 h | L/M/L | offline for correctness; real for benefit | Model-facing refusal text: setting, default off |
| 15 | **Turn-level "Undo reviewed changes"** (preflight all hashes, reverse order, refuse on conflict) | ED §8 | Medium: visible safety | 2.5 h | L/M/L | offline (extension suite) | No |
| 16 | Benchmark label correction (missing `settlement.ts` gold path; versioned corrected labels, originals kept) | CE baseline | Low-medium: honesty of numbers | 0.5 h | none | offline | No |
| 17 | Inline edit: document version captured with the selection, stale selection refused before send | ED §2 | Low-medium: safety | 0.75 h | M/L/M | offline | No |
| 18 | Keyed, collapsible tool timeline (patch rows by id; collapse finished reads) | ED §13 | Low-medium: visible on long runs | 2 h | L/L/L | offline | No |
| 19 | Smaller initial pack with implementation/test/docs reservation (2k + reservation) | CE #1/§4, ED §4 rank 3 | Medium (tokens), but A/B quality risk | 3 h | L/M/L | offline benchmark; real for B | Setting, default 4,000 unchanged |
| 20 | Panel keyed delta transport (text deltas + control patches, snapshot on resync) | ED §1 rank 2 | Low for judges (no visible change) | 4 h+ | L/L/L | offline (responsiveness) | No |
| 21 | Destructive-hunk warning: jump to the hunk, badge in diff | ED §14 | Low | 1 h | L/L/L | offline | No |
| 22 | Observed test status: "tested saved files only" for dirty buffers | ED §15 | Low | 1 h | L/L/L | offline | No |
| 23 | Deduplicate already covered source ranges in the pack | CE #3 | Low-medium | 2 h | L/M/L | offline benchmark | Setting |
| 24 | Scoped search hints / multi-pattern search | MT §3 | Low-medium | 2 h | L/M/L | offline; real for benefit | Setting |
| 25 | Compact `list_files` directory summary + continuation | MT §7 | Low | 1.5 h | L/L/L | offline | Model-facing → setting |
| 26 | `find_symbol` reusing the shared index (no rebuild per call) | MT §6 | Low (ms) | 1.5 h | L/L/L | offline | No |
| 27 | `gather_context` refinement mode (new evidence since last pack, role hints) | MT §1 | Medium, unproven | 4 h | L/M/L | real for benefit | Setting |
| 28 | Remove redundant bwrap probe from steady-state launch (≈4 ms) | CS fail-closed | Low (ms) | 2 h | L/L/L | offline | No |
| 29 | Explicit child-environment allowlist audit | CS env | Low (already short env) | 1 h | L/L/L | offline | No |
| 30 | Versioned provider secret rule set for output redaction | CS redaction | Low-medium | 2 h | L/L/L | offline | No |
| 31 | Phase-aware watchdog and stream reconciliation (reconnect instead of 45/120 s) | RS §4, AL §7 | Medium, large change | 10 h+ | M/H/L | offline + real | Not in Round 1 |
| 32 | One retry budget across TrueForge HTTP retries and harness retry (4 → 2, skip same-route restart) | RS §3 (best 50% candidate) | Medium, needs fault campaign | 8 h | M/H/M | real | Not in Round 1 |
| 33 | Route-health ledger / circuit breaker; independent fallback family | RS §1, AL §3 | Medium; needs a different model | 8 h+ | M/M/H | real | Skip (different model) |
| 34 | Localization bundle tool (ranked candidates + exact ranges + hashes) | AL #1/#5 | Medium-high long term | 10 h+ | L/M/L | real | Not in Round 1 |
| 35 | Plan-then-act / exact-anchor edit format | AL §2 | Medium, model-dependent | 12 h+ | L/M/L | real (many runs) | Skip |
| 36 | Harness-owned ledger, shaped tool results, later compaction | AL §4 | Medium | 8 h+ | L/M/L | real | Skip |
| 37 | Phase budgets / no-progress detection | AL #6/§8 | Medium | 12 h+ | L/H/L | real | Skip |
| 38 | Named read-only explorer agent | AL §5 | Low (net requests unproven) | 10 h+ | L/H/M | real (many runs) | Skip |
| 39 | Grouped multi-file review + native diff queue | ED §3/§6 | Medium-high, but 24 h | 24 h | L/H/M | offline + human study | Skip |
| 40 | Typed verification operations / safe-list semantics hardening | CS safe-list, MT §5 | Medium | 10 h+ | L/H/L | offline + real | Skip |
| 41 | Interpreter runtime manifest, resource ceilings, Landlock | CS mounts | Medium | 10 h+ | L/H/L | offline | Skip |
| 42 | Incremental index updates | CE #4/§1 | Low-medium (ms) | 14 h | M/M/M | offline | Skip |
| 43 | Tree-sitter multi-language symbols, skeleton views | CE §2/#5 | Medium | 20 h | M/M/L | offline | Skip (new native deps) |
| 44 | Typed two-hop graph ranking, deterministic query expansion | CE §3/#7/#9 | Low-medium | 7–14 h | L/M/L | offline | Skip |
| 45 | Semantic model alternatives (BGE, Jina, cross-encoder) | CE §6/#8 | Low (warmed MiniLM lowered recall) | 12 h+ | L/M/L | offline | Skip (new models) |
| 46 | 100-case held-out retrieval corpus | CE §7/#10 | Medium long term | 20 h | none | offline | Skip |
| 47 | Daytona Code Mode exploration, skills, large-tool-response offload | AL other | Low (cloud) | 6–12 h | L/M/L | real + cloud | Skip (new cloud service) |
| 48 | Memory / inline resources / questions | AL other | None for A/B/C | — | — | — | Reject (report rejects) |
| 49 | Run manifest + phase telemetry instrumentation | AL plan 1, ED plan 1, RS rollout 2 | Medium for evidence | 4 h | L/L/L | offline | Partially exists (meter); skip |

Rejected by the reports and not considered: replacing the TrueForge loop, mandatory delegation, fuzzy apply, edit
auto-approval, silent post-write fallback, default Daytona, global watchdog halving, task hedging, semantic on by default,
cloud indexes, blanket auto-approval.

## Sprint order

1 → 9 first (each ≤ 2 h, offline-provable, A/B/C risk low), then 11, 12, 13, 10, 14, 15 as time allows before 20:30.
Items that touch the agent loop or model-facing text are marked in the status table below so a Task B failure in the
5a smoke can be traced to them.

## Status

| # | Status | Commits | Touches agent loop / model-facing? |
|---:|---|---|---|
| 1 Verification verdict | in (`7a703d0`) | `7a703d0` | No (panel reporting only) |
| 2 Write barrier across Resume | in | `af6b00e` | **Yes: recovery policy in the turn loop** (resumed turns only) |
| 3 Secret masking for source | in (default on; Flask scan: 0 hits in 230 files) | `930676f`, `16ce3e8` | **Yes: model-facing text** (tool output and turn input) |
| 4 Fallback recovery card | in | `81a2a72` | No (UI) |
| 5 Grouped context report | in | `303faf8` | No (UI) |
| 6 Long Retry-After for Resume | in | `58fbc45` | No (Resume suggestion only) |
| 7 Status-first classification | in | `ffa2704` | **Yes: retry/fallback decision** |
| 8 Three-state Stop | in | `249ab26` | Status text only (harness `cancelling` detail) |
| 9 Command prompt facts | in | `75aeefe` | No (UI) |
| 11 Resume when ready | in | `f95cb77` | No (UI; uses the existing Resume) |
| 13 Effective settings | in | `636e021` | No (UI) |
| 12 Attach picker | in | `de868e2` | No (UI; mentions the harness already parses) |
| 10 Multi-range `read_file` | in, setting `forge.tools.multiRangeRead` default **off** | `25e9040` | Model-facing tool schema **only when enabled**; default schema unchanged (unit test) |
| 14 `propose_edit` no-match hints | in, setting `forge.tools.editHints` default **off** | `17c1012` | Model-facing refusal text **only when enabled**; default text unchanged (unit test) |
| 15 Undo this turn's changes | in (panel button + command; preflight all hashes, newest first) | `ce8ffdb` | No (editor only; VS Code e2e: Task B's 3 files restored, git clean) |
| 16 Benchmark label correction | in (`--labels=corrected`; original kept; figures equal on both: recall@5 .750, MRR .795) | `002669b` | No (benchmark only) |
| 17 Inline stale selection refused | in | `3ce5ecb` | No (editor only) |
| 18 Keyed, collapsible tool timeline | in (responsiveness gate passed) | `b6e4b6c` | No (UI) |
| 22 "Tested saved files only" | in | `e640085` | No (UI) |
| 21 Destructive-hunk warning links | in (jump to the hunk) | `385b037` | No (UI) |
| 29 Child-environment allowlist | already explicit (7 variables); pinned by a test | `8f40a93` | No (test only) |
| 30 Versioned secret rule set | not started: rule set already covers NVIDIA/OpenRouter/Anthropic/OpenAI/Groq/GitHub/GitLab/AWS/Google/Slack/HF | — | — |
| 26 `find_symbol` shared index | not started: saves ms, risks a stale index | — | — |
| 19, 20, 23, 24, 25, 27 | not started (behind-a-setting with no default effect, or 3 h+) | — | — |
| 31–49 | not started (Round 2 or rejected, per ranking) | — | — |
