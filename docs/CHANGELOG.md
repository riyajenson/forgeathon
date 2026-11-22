# Changelog

Builds are identified by commit. The final Round 1 build is tag `round1-final`.

| Build | Commit | Date |
|---|---|---|
| Original Round 1 submission | `2b265c7` | 2026-11-20 |
| Updated Round 1 build (deadline extended; hybrid retrieval and review efficiency merged) | `31fffd2` | 2026-11-21 |
| Finals build (TrueForge depth, Daytona spike merged; protocol 0.4.8) | `babc29c` | 2026-11-22 |
| Second extended build (base of the research sprint) | `28e8f9e` | 2026-11-22 |
| Research sprint merged (real A/B/C evidence on `255107f`) | `94bb12d` | 2026-11-22 |
| Presentation cleanup (docs only; no runtime change) | tag `round1-final` | 2026-11-22 |

## Presentation cleanup (tag `round1-final`)

Documentation only: README rewritten for first-time readers, internal process notes moved to `docs/internal/`, this
changelog added, old tags replaced by commit SHAs in the docs. No change to the extension, harness, scripts' behaviour,
agent definitions or model configuration.

## Research sprint (`94bb12d`, 22 Nov)

Items from six research reports
([triage](ROUND1-SPRINT.md)), each with offline tests (unit, integration on TrueForge with the scripted model, mock
end-to-end, VS Code suites); protocol unchanged (0.4.8):

- **Panel:** a verification verdict at turn end ("⚠ Unverified" when files changed and the last test run failed, is stale
  or never ran; "✓ Verified" only when the last run passed after the last edit); one fallback recovery card (from → to,
  reason, fresh TrueForge session, no files changed); the context report grouped into pinned items, files and skip reasons
  (full list on demand); Stop in three states (requested and what is settling → stopped and settled, naming files changed
  before the stop); the command prompt states two separate facts (allowlist classification; sandbox active, read-only,
  offline, no keys); **Resume when ready** (one scheduled Resume, cancelled by Stop, a new turn or closing the panel);
  an **Attach…** picker for `@file:`/`@symbol:` mentions; **Undo this turn's changes** (every reviewed file of the
  latest turn, newest first, after checking none changed since); a collapsible tool timeline; destructive-hunk warnings
  link to the hunk; the observed test result says "tested saved files only" when buffers were unsaved; command
  *Forge-a-thon: Show Effective Settings*.
- **Safety:** credential-shaped strings (provider key prefixes, private keys, the configured keys' values) are masked in
  file text sent to the model and so to TrueForge traces (`forge.context.maskSecrets`, on; 0 hits in Flask 3.1.3); a
  resumed turn inherits "already wrote", so it never retries or falls back automatically; an inline selection that
  changed while the instruction was typed is refused.
- **Resilience:** an explicit HTTP status decides the error class first (429/5xx with "key" or "credit" wording is
  transient; 401/403 fall back at once); a provider's longer wait hint (up to an hour, minutes understood) sets when Resume
  is offered.
- **Opt-in, off by default** (they change what the model sees; their request savings are unmeasured):
  `forge.tools.multiRangeRead` (several line ranges per `read_file`), `forge.tools.editHints` (a no-match `propose_edit`
  refusal names the closest current text).
- **Benchmark:** corrected labels (`--labels=corrected`; a gold path that never existed); original labels kept.
- **Evidence (real models, nvidia-free, one paced run each, 22 Nov 19:05–19:13 IST, `255107f`):** A 6/6 (first diff
  13.9 s, 3 requests), **B 8/8 checks (first diff 46.5 s, 421.8 s, 60 requests, two compactions)**, C 3/3 (401 → OpenRouter,
  4 requests); no 429. One run cannot show a speed-up or slow-down against the earlier B (216.8 s, 48 requests).


, `feature/hybrid-efficiency-native` and `harness/p15-daytona` (protocol 0.4.8):

- **Review:** a multi-select hunk picker whose diff follows the checked hunks (✓ accept all, ✕ reject all); edits are applied
  and undone hunk by hunk; hunks that delete a whole class or function are flagged ("Destructive hunks").
- **Guardrails:** separate per-turn budgets for test runs (3) and other commands (3); `cd … && …` is refused with the
  corrected call, without using the budget; the panel shows the observed result of the last test run next to the model's
  claim, and marks it stale when files changed after it.
- **Resilience:** a 120 s silence limit while a model request is in flight (45 s otherwise); a turn stopped after writes by a
  429 or a stall offers **Resume** in the same TrueForge conversation (after a fallback: the fallback's conversation and
  model); Stop also kills a sandboxed command that had just started.
- **TrueForge depth:** compaction at 40k input tokens (once per Task B, its start and end shown); dynamic sub-agents on for
  `forge-coder` (the model decides; "read-only" is an instruction, and a sub-agent's edits still go through the same review;
  Nemotron did not delegate in 6 real runs); opt-in Daytona sandbox, git skill and Code Mode
  spike (`scripts/daytona-spike.sh`, needs `DAYTONA_API_KEY` in `.env.daytona` with sandbox and snapshot write/delete
  permissions; files Code Mode reads go to Daytona's cloud; edits stay approval-gated).
- **Context:** the workspace index is built in the background; 4,000-token default budget; **opt-in** local semantic
  reranking (`forge.context.semanticSearch`, off by default; embedding model `onnx-community/all-MiniLM-L6-v2-ONNX`, CPU,
  downloaded from Hugging Face on first use after `scripts/enable-semantic-search.sh`).
- **Evidence (22 Nov, real models, nvidia-free, one run each):** on the finals code (`0be9897`, the merged build; later commits
  change docs, tests and tooling, plus the Resume-after-fallback fix `c47e092`, tested with the scripted model only): **Task B 6/6, first diff 100.3 s, 216.8 s, 48 requests**; A 6/6; C 3/3 (401 → OpenRouter);
  no 429. On `harness/p14-trueforge-depth` at `5710431`, before the hybrid merge: B 6/6 (63.0 s / 184 s, 45 requests), B with
  a sub-agent request 6/6 (59.9 s / 203 s, 44 requests, no delegation), A 6/6, C 3/3. Details:
  [`docs/writeup/rehearsal.json`](writeup/rehearsal.json), [`docs/STATUS.md`](STATUS.md).
