# Repository agent instructions

## Round 1 requirements and task tracking

- Read `docs/SUBMISSION-CHECKLIST.md` before changing judged behavior or submission materials. It is the canonical task-status list; do not create a second checklist here.
- The fixed demo tasks use Flask 3.1.3: inline `get_debug_flag` edit, an unprompted three-or-more-file `flask config` change, and a resilience run with an invalid key or unreachable endpoint.
- Update the checklist and `docs/writeup/WRITEUP.md` only when there is evidence for the status or claim. Keep demo timestamps and real-model outcomes tied to actual recordings/runs.
- For multi-step work, use the approved design/plan in `docs/superpowers/` and keep its task status current.

## Architecture and context retrieval

- TrueForge owns agent sessions, turns, model calls, tool decisions, streaming, retry, fallback, and cancellation. Do not add direct provider calls or a second agent loop.
- Expose editor actions to the agent through the existing MCP tools.
- Build context from keyword evidence and code structure first: symbols, imports, tests, and relevant docs. Run local semantic reranking only when the lexical/structural shortlist is weak, and keep it limited to that shortlist.
- Preserve selected text and explicit `@file`/`@symbol` references ahead of automatic results. Enforce the configured token budget and report selected items, reasons, token use, and skipped items in the agent panel.
- In agent mode, state a concise candidate-file plan with reasons from the context report before the first edit or command; search or gather more context before naming files without evidence.
- If semantic inference is unavailable or misses its wait limit, keep the deterministic lexical/structural result and explain that in the context report.

## Review and workspace safety

- Do not apply proposed edits without the existing per-hunk review flow. Preserve base-hash checks, rejection behavior, undo receipts, and cancellation settlement.
- Keep the workspace consistent on failures and cancellation; do not report completion while an editor write or approved tool is unsettled.
- Do not claim a speedup or retrieval-quality improvement without paired measurements on the same tasks and model configuration.

## Branch discipline

- Keep work on the user's requested feature branch and preserve existing changes in the shared worktree.
- Do not push or merge unless the user asks.
