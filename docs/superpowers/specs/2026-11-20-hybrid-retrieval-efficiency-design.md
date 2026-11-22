# Forge capability efficiency design

## Intent

Improve Forge's end-to-end usefulness and efficiency across inline editing, multi-file agent work, context selection, review, and streaming/cancellation. Preserve the current TrueForge-owned agent loop and all write-safety guarantees.

The current target is at least 50% lower cost in a capability-specific efficiency metric (time, model tokens/requests, or review actions per verified task). It is a target, not an assumption: the research sources use different tasks and metrics, and none establishes a universal 50% gain for Forge. Report paired results against a repeatable baseline and do not claim a gain that was not measured.

## Current state

- `src/harness/context/engine.ts` pins the user selection and explicit `@file`/`@symbol` references, then adds automatically ranked context within a token budget. `ContextReport` records source, rank, rationale, truncation, and skipped items.
- `src/harness/context/workspace-index.ts`, `chunks.ts`, and `rank.ts` build chunks and rank them using lexical and structural heuristics. The write-up reports 0.2–0.3 seconds for Flask indexing plus ranking, and 7,456 of 8,000 tokens packed for Task B.
- Workspace structure also resolves relative JavaScript/TypeScript imports and common colocated test names. This is deterministic and does not invoke the semantic model.
- `buildIndex` already keeps per-`EditorPort` chunk-analysis results in a `WeakMap`, keyed by file SHA-256. It still lists and reads visible files and rebuilds the aggregate index on each call. The improvement should reuse this cache and add hash-keyed semantic vectors, rather than build a second competing cache.
- The TrueForge turn in `src/harness/turn/` owns agent execution, streaming, retries/fallback, and cancellation. The extension consumes sequenced events in `extension/src/turn.ts` and renders state in `extension/src/agentPanel.ts`.
- `AgentPanel.refresh()` already coalesces full-state webview messages with a 40 ms timer. Do not assume rendering is a bottleneck; first measure message-to-paint delay and serialization/paint cost.
- Edit proposals are verified in `src/harness/review/` and `extension/src/review.ts`. The extension checks the approved text against the base hash, applies only accepted hunks, and keeps undo receipts. `extension/src/inlineReview.ts` provides the diff and per-hunk controls.
- The real-model rehearsal records A/B/C passing on commit `f67c719`; the current `HEAD` descends from it with documentation-only commits. Task B took 97.8 seconds, used 37 model requests, and needed five reviews. These figures are one run, not a stable baseline.

## Research evidence and limits

- [CoRet (ACL 2025)](https://aclanthology.org/2025.acl-short.62/) combines code semantics, repository structure, and call-graph dependencies. It reports at least 15 percentage points higher retrieval recall on SWE-bench and Long Code Arena localization datasets. This supports testing structural and semantic retrieval together; it does not predict Forge's Task B result.
- [AIRCoder (ACL 2026)](https://aclanthology.org/2026.acl-long.1166/) combines textual, dependency, and structural signals and reports 10.2× efficiency and 4.63% average exact-match improvement on repository code-completion benchmarks. Completion is not the same task as agentic issue repair.
- [Agentless](https://arxiv.org/abs/2407.01489) reports a three-phase localization, repair, and validation approach at 32% on SWE-bench Lite for $0.70 in its evaluation. Forge cannot replace TrueForge's loop, but the phase separation is a useful planning pattern inside the existing loop.
- The [SWE-agent paper](https://arxiv.org/abs/2405.15793) evaluates how agent-computer interfaces affect software task completion and cost. This supports treating tool and feedback design as part of the algorithm, not just prompt wording.
- Meta's [AI-assisted code review study](https://arxiv.org/abs/2507.13499) reports that showing AI patch suggestions inline increased review time by over 5% in a safety trial; hiding/collapsing the suggestions removed the measured regression. It is a production study of review-comment fixes, not Forge's per-hunk code review, so the practical lesson is to test the review UI and keep proposed changes easy to scan rather than always expanding more AI output.
- A [Kaggle issue-resolver notebook](https://www.kaggle.com/code/olaflundstrom/konwinski-prize-ai-github-issue-resolver-tb) combines syntax-tree parsing, Elasticsearch, and explicit file/search tools, but reports roughly two hours of inference; it is an architectural example, not evidence for a speedup.
- A [Stack Overflow accepted answer](https://stackoverflow.com/questions/58763318/how-to-write-async-code-promises-with-vscode-api-withprogress) explains that synchronous child-process work blocks the VS Code UI and recommends asynchronous process APIs. It is practical but old and anecdotal. Forge already streams asynchronously, so cancellation and rendering changes must be justified by Forge-specific measurements.
- The [VS Code API cancellation-token documentation](https://code.visualstudio.com/api/references/vscode-api) describes cancellation for work whose results become obsolete. A [Stack Overflow question about streamed editor diffs](https://stackoverflow.com/questions/79358870/vs-code-editor-edit-blocking-for-extended-period-during-streaming-diff-in-extension) reports long `editor.edit` delays but has no accepted answer, so it is a reported failure mode rather than a validated optimization.
- The [VS Code talk “Your Codebase, Your Rules”](https://www.youtube.com/watch?v=_fZZz_gIE8A) describes semantic code search and context customization in the editor. It is useful product guidance, not a controlled Forge performance result.
- The 2026 [CodeGrep preprint](https://arxiv.org/html/2608.05886v1) reports 19% fewer tokens and 15% fewer rounds on resolved SWE-bench tasks with a separately trained 14B retrieval agent, while solve rate moves from 25.8% to 27.0%. The model size and experimental setup make this a research comparison, not an appropriate local Forge dependency or evidence of a 50% gain.
- No reviewed source demonstrates a 2× gain in all five Forge capabilities. Results must be established on the same Forge workloads and model configuration.

## Goals

1. Improve relevant context per token and reduce repeated indexing/retrieval work.
2. Improve successful multi-file completion per model request and per second, without reducing verified task pass rate.
3. Reuse the same retrieval path for inline selection context and agent-mode tasks.
4. Reduce review and cancellation overhead only where baseline measurements identify it as a bottleneck.
5. Keep the extension responsive and preserve exact approval, stale-base refusal, undo, and workspace-consistency behavior.
6. Keep the extension independent of any one model provider and retain TrueForge as the agent loop.

## Non-goals

- Replacing TrueForge or adding another autonomous agent framework.
- Guaranteeing a 2× result before measurement.
- Sending workspace code to a new external embedding or reranking service.
- Relaxing per-hunk review, hash checks, command approval, or cancellation settling.
- Adding parallel agents in this iteration.

## Approaches considered

### 1. Hybrid retrieval with selective semantic reranking — selected

Combine the existing lexical ranking with exact symbol matches and repository relationships. When lexical/structural confidence is low, run a local semantic retriever over a bounded candidate set and fuse ranks. Cache the workspace index and embeddings by file content hash. Keep the TrueForge turn staged: identify candidate files, read only the best candidates, make a concise edit plan, propose changes, then run relevant verification.

Tradeoff: better recall for vocabulary mismatch while keeping expensive ranking selective; adds a local inference/runtime and index invalidation problem.

### 2. Structure-first retrieval without embeddings

Expand exact symbols, imports, calls, tests, docs, and recent changes from lexical search. This is smaller, deterministic, and easy to run offline, but weaker for natural-language queries whose terms do not appear in code.

### 3. Parallel specialist agents

Run separate discovery, editing, and verification agents. This may improve coverage but adds model calls, conflict resolution, latency, and more complex approval semantics. It does not fit the present efficiency goal as well as improving retrieval in the existing single TrueForge loop.

The user selected approach 1. Semantic model/runtime selection remains a design decision: it must be local, optional, lazy-loaded, and safely fall back to the current lexical path if unavailable. The implementation plan should compare viable packages before choosing one.

## Proposed behavior

### Retrieval and context (capabilities 1–3)

1. Preserve user selection and explicit mentions as pinned context. They always outrank automatic candidates, subject to secret/binary refusal and budget reporting.
2. Extend the existing per-`EditorPort`, content-hash analysis cache with hash-keyed semantic vectors. Preserve the current aggregate BM25 and neighbor data; refresh it after the workspace listing/read detects file changes. Do not add a second index/cache layer.
3. Retrieve with several bounded signals: BM25 over identifiers and prose, exact symbol/path matches, structural neighbors, and semantic similarity over chunk embeddings. Fuse ranked lists with a stable rank-fusion method; do not add raw scores with incompatible scales.
4. Use semantic retrieval only when the lexical/structural top candidates are weak or do not cover the task's requested entities. Limit it to the top candidate set. Keep a deterministic lexical-only fallback.
5. Pack context by marginal relevance per estimated token, while reserving budget for pinned references and a small amount of dependency/test context. Deduplicate overlapping chunks and avoid repeating whole files already covered by selected chunks.
6. Return the ranked evidence in `ContextReport`: why each item was selected, which signal found it, token cost, confidence, and what was skipped. The panel should expose the file shortlist before or during the agent's first tool cycle.
7. For agent mode, have the model produce a compact candidate-file plan before edits. Permit iterative `gather_context` expansion when evidence is missing; stop expansion when new evidence is low-value. Keep the model responsible for choosing tools and edits through TrueForge.
8. For inline mode, retrieve the selected symbol's containing chunk and relevant callers/callees or tests, while keeping the selected text pinned and bounded.

### Review and writes (capability 4)

Keep the existing review and application protocol. Optimize interaction only after timing the current path. Candidate low-risk changes include keyboard-friendly accept/reject controls and a compact turn-level list that lets the user navigate several file diffs while retaining per-hunk choices; keep diffs collapsed until selected, rather than presenting every AI suggestion expanded at once. Every accepted change remains bound to the exact reviewed base hash; rejected hunks remain unapplied; saved edits remain undoable. Do not make the agent's plan or a confidence score an approval substitute.

### Streaming and cancellation (capability 5)

Keep sequenced TrueForge events, immediate cancellation requests, and settlement of in-flight editor writes. Instrument event arrival-to-render delay and cancel-to-quiescence. If panel rendering is the bottleneck, coalesce only replaceable text deltas for display while retaining the canonical event sequence and never coalescing tool, approval, error, edit-applied, or terminal events. Cancellation must still close pending approvals, abort commands, and await any write already submitted to VS Code before declaring the terminal state.

## Efficiency targets and evaluation

Establish a baseline before implementation using the pinned Flask A/B/C tasks plus a small, labeled repository-retrieval set. Record model/provider, commit, warm/cold index state, tokens, requests, wall time, review interactions, and outcome. Run deterministic UI/turn race cases with the mock model; run the real model on a repeated representative subset so stochasticity is visible.

The 50% cost-reduction targets are measured independently:

| Capability | Primary efficiency metric | Required invariant |
|---|---|---|
| Inline edit | Median instruction-to-first-diff latency and model tokens per accepted correct edit | Selection honored; preview matches applied text; undo works |
| Multi-file agent | Model requests/tokens and wall-clock time per verified 3+ file task | Same or higher test-pass rate; no user-named files; TrueForge owns the loop |
| Context | Relevant-file recall@k and relevant files per 1,000 context tokens; cold/warm latency reported separately | Explicit references retained; secret/binary refusal and budget accounting remain correct |
| Per-hunk review | Median reviewer time and actions per correctly accepted/rejected hunk | No unreviewed writes; stale base rejected; undo restores exact text |
| Streaming/cancellation | p95 approval/control event-to-paint latency | Text remains ordered; cancellation-to-quiescence does not regress; exactly one terminal event; zero inconsistent workspace outcomes |

The target is a 50% reduction in the primary cost metric for each capability, with the invariant preserved and no regression in end-to-end task pass rate. If a metric is near its physical/API floor, report the measured ceiling rather than manufacture a gain. Do not claim improvement based on one run. Compare paired runs on the same tasks and model settings, and report medians, p95 where appropriate, and failure counts.

## Risks and mitigations

- Local embeddings may add startup time, memory use, and extension size. Lazy-load them, cache by content hash, keep the model optional, and compare cold/warm results.
- Embedding retrieval can surface plausible but irrelevant chunks. Fuse with exact lexical/structural evidence, display rationales, and evaluate recall and precision on labeled tasks.
- Incremental index invalidation can become stale after external edits, renames, or branch switches. Hash source chunks and verify workspace versions before use; rebuild when consistency cannot be established.
- Larger retrieved context may increase token costs without improving fixes. Enforce a hard budget and measure relevant-context density.
- More aggressive batching could obscure which hunk a user approved. Preserve file, hunk, base hash, and undo receipt identity end to end.
- A cancellation optimization could lose a late write or lie about terminal state. Keep the current settlement invariant and test races around approval, apply, save, stop, and fallback.

## Open decisions for implementation planning

- Which local embedding runtime/model meets size, latency, license, and Node/VS Code extension-host constraints.
- Which labeled retrieval queries and relevant-file annotations should form the first benchmark set beyond Flask Tasks A/B/C.
- Whether the existing UI review path is actually a bottleneck before adding a cross-file review queue.
- What minimum repeat count and model budget are available for paired real-model evaluations.
