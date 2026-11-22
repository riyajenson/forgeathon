# Hybrid Context and Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve retrieval quality and reduce repeated context and model work for inline and multi-file tasks while preserving pinned references and the hard context budget.

**Architecture:** Extend the existing per-editor, hash-keyed chunk-analysis cache with local semantic vectors. Fuse semantic, lexical, and existing structural rankings by reciprocal rank fusion; run semantic scoring only on a bounded candidate set when lexical evidence is weak. TrueForge remains the agent loop and receives the selected context and rationale through the existing context report.

**Tech Stack:** TypeScript 5.x, Node.js >=22.14, existing Node test runner, `@huggingface/transformers` 4.3.2, CPU ONNX inference using `onnx-community/all-MiniLM-L6-v2-ONNX` revision `2a90286a00a3fba4a0c16c5ea113091359ad5c86` (`q4`). Load the model lazily in a worker thread and keep model files/cache outside the workspace.

**Spec:** `docs/superpowers/specs/2026-11-20-hybrid-retrieval-efficiency-design.md`

## Global Constraints

- TrueForge remains the only agent loop; no direct provider SDK calls.
- Keep selected text and explicit `@file` / `@symbol` references pinned ahead of automatic results.
- Preserve the 8,000-token default budget, secret/binary refusal, and skipped-item reporting.
- Embedding inference runs locally; workspace source is not sent to an embedding service.
- If weights are unavailable, inference fails, or a query is cancelled, use the current lexical/structural retrieval path.
- Do not claim 2× improvement without paired benchmark results and unchanged or improved task pass rate.

## Review Focus

- Semantic weights are missing or the machine is offline: semantic search falls back to lexical retrieval and the turn continues.
- A file changes while embeddings are cached: its vector is invalidated by path and SHA-256 before use.
- Explicit refs or selected text compete with semantically similar chunks: explicit context remains pinned and is not displaced.
- A query contains no useful terms: avoid division-by-zero and return a deterministic bounded result.
- A large workspace triggers indexing or model inference: the extension host remains responsive and cancellation abandons the semantic result safely.

---

### Task 1: Retrieval benchmark baseline

**Files:**
- Create: `src/harness/context/retrieval-benchmark.ts`
- Create: `src/harness/context/retrieval-benchmark.json`
- Create: `scripts/bench-context.mjs`
- Test: `src/harness/context/context.test.ts`

**Interfaces:**
- Consumes: existing `buildIndex(port)` and `rankFiles(index, task)`.
- Produces: `RetrievalBenchmarkCase { id, query, expectedPaths }`, `RetrievalBenchmarkResult { caseId, rankedPaths, packedPaths, packedTokens, elapsedMs }`, and `measureRetrieval(results) -> { recallAt5, mrr, relevantFilesPer1000Tokens, medianElapsedMs }`.

- [ ] **Step 1: Add benchmark cases and a failing metric test.** Include labeled retrieval cases for the Flask Task A symbol, Task B CLI/test/docs files, and at least ten varied code tasks with expected relevant paths.
- [ ] **Step 2: Run the focused harness test.** Run `npm --prefix src/harness test`; expected: the new metric test fails because the benchmark module is not implemented.
- [ ] **Step 3: Implement the deterministic metric functions and CLI.** Record cold/warm index time, top-5 recall, reciprocal rank, packed relevant-token density, and model/token metadata when available.
- [ ] **Step 4: Run the harness suite and baseline CLI.** Expected: tests pass and `node scripts/bench-context.mjs --mode lexical` writes a machine-readable baseline report without contacting a model provider.
- [ ] **Step 5: Commit the benchmark.**

### Task 2: Local semantic worker and hash-keyed vector cache

**Files:**
- Create: `src/harness/context/semantic.ts`
- Create: `src/harness/context/semantic-worker.ts`
- Modify: `src/harness/context/workspace-index.ts`
- Modify: `src/harness/package.json`
- Modify: `src/harness/package-lock.json`
- Test: `src/harness/context/context.test.ts`
- Test: `extension/test/responsiveness.cjs`

**Interfaces:**
- Consumes: `IndexedChunk` path, start/end lines, text, and the existing `FileAnalysis.sha256` cache.
- Produces: `LocalSemanticRanker.rank(query: string, chunks: readonly IndexedChunk[], signal?: AbortSignal): Promise<ReadonlyMap<string, number>>` keyed by stable `path:startLine:endLine` chunk IDs; `dispose(): Promise<void>` terminates its worker.

- [ ] **Step 1: Add tests for chunk-key stability, hash invalidation, missing-model fallback, and cancellation.**
- [ ] **Step 2: Run `npm --prefix src/harness test`; expected: the new tests fail because the ranker and worker are absent.**
- [ ] **Step 3: Add `@huggingface/transformers@4.3.2` and implement a lazy worker using the pinned model revision and CPU `q4` inference. Show cancellable progress for the one-time model download. Store vectors beside the existing per-port analysis cache, keyed by file SHA and chunk range. Never persist vectors in the workspace.**
- [ ] **Step 4: Run `npm --prefix src/harness test` and `npm --prefix src/harness run typecheck`; expected: vectors are reused for unchanged chunks, invalidated for changed content, and lexical fallback succeeds if the model is unavailable.**
- [ ] **Step 5: Commit the local semantic adapter.**

### Task 3: Hybrid rank fusion and budget-aware packing

**Files:**
- Modify: `src/harness/context/rank.ts`
- Modify: `src/harness/context/engine.ts`
- Modify: `src/harness/context/index.ts`
- Modify: `src/harness/mcp/context-tool.ts`
- Test: `src/harness/context/context.test.ts`

**Interfaces:**
- Consumes: `LocalSemanticRanker.rank(...)` from Task 2.
- Produces: `ContextRequest.semanticSearch?: boolean` and `rankFiles(index, task, semanticRanks?) -> { files, queryTerms }`, with deterministic reciprocal-rank fusion and existing lexical-only behavior when semantic ranks are omitted.

- [ ] **Step 1: Add tests for rank fusion, weak-evidence activation, deterministic ties, empty queries, explicit-reference priority, and token-budget compliance.**
- [ ] **Step 2: Run `npm --prefix src/harness test`; expected: fusion and fallback tests fail before implementation.**
- [ ] **Step 3: Score semantic results only for the lexical top 20 plus existing structural neighbors, and only when the top lexical candidates have under 40% task-term coverage or the top-two lexical score margin is under 10%. Fuse ranks with reciprocal rank fusion; do not mix raw score scales.**
- [ ] **Step 4: Pack non-overlapping chunks by marginal relevance per estimated token after pinned context. Add a semantic/structural reason to the existing `ContextReport.rationale`; preserve skipped reasons and the 8,000-token cap.**
- [ ] **Step 5: Run the harness suite and `node scripts/bench-context.mjs --mode hybrid`; expected: all invariants pass and the report compares lexical vs hybrid on identical cases.**
- [ ] **Step 6: Commit hybrid retrieval.**

### Task 4: Agent and inline retrieval behavior

**Files:**
- Modify: `src/harness/turn/prompt.ts`
- Modify: `contracts/session.ts`
- Modify: `contracts/protocol.ts`
- Modify: `extension/package.json`
- Modify: `extension/src/workbench.ts`
- Modify: `extension/src/turn.ts`
- Modify: `src/harness/harness.ts`
- Modify: `src/harness/turn/turn.ts`
- Modify: `agent/forge-coder.json`
- Modify: `agent/forge-inline.json`
- Modify: `src/harness/turn/turn.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: ranked context and rationale already sent in `ContextReport` and `gather_context` results.
- Produces: `TurnRequest.semanticSearch?: boolean`, extension setting `forge.context.semanticSearch`, and instructions that use the shortlist to plan candidate files, expand context only when evidence is missing, consolidate all edits per file into one proposal, and verify the smallest relevant test set. The 2026-11-22 follow-up below supersedes the original default-off decision.

- [x] **Step 1: Add prompt-construction regression cases for preserving explicit refs, showing the shortlist, one context expansion when needed, and one consolidated proposal per file.**
- [x] **Step 2: Run `npm --prefix src/harness test`; expected: the prompt assertions fail before the instruction changes.**
- [x] **Step 3: Add the `semanticSearch` turn field and default-false extension setting; bump the protocol version to 0.4.5 and pass the setting from Workbench through TurnController into context assembly.**
- [x] **Step 4: Update inline and coder instructions to use the same ranked evidence; require a short file plan before multi-file writes, and prohibit guessing file paths when the context report has not been inspected.**
- [x] **Step 5: Document local model download behavior (about 54 MB), the semantic-search setting, cache location, first-run cost, offline fallback, and benchmark commands.**
- [x] **Step 6: Run the context benchmark and fixed A/B mock workflow.** At that time, the paired benchmark missed 2×, so semantic stayed off by default. The Task A/B pass rate could not be measured because the required Flask checkout was unavailable; see the SDD ledger. This default decision was superseded by the bounded, confidence-gated follow-up below.
- [x] **Step 7: Commit the prompt and documentation changes (`26dff8e`).**

### Follow-up decision (2026-11-22)

For the Round 1 context anchor, the extension now enables selective semantic reranking by default when the lexical/structural shortlist has low term coverage or a close top-two margin. It ranks only the top 20 keyword candidates plus structural neighbors, waits up to 200 ms, then uses lexical/structural ranking while a slower local worker continues warming its cache. The context panel places the chosen files, plain-language reasons, token budget, and omissions before the agent response. The local runtime remains optional, and the earlier immediate-fallback benchmark does not measure this bounded-wait behavior.
