# Review Efficiency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove one interaction from per-hunk review while retaining exact-base checks and undo, then measure whether that raises real review throughput.

**Architecture:** Replace the initial Accept All / Reject All / Choose Hunks menu plus second picker with a single multi-select hunk picker shown beside the diff. Add Accept All and Reject All as top-level picker buttons, preserve the existing review protocol, and measure hunk-choice actions without recording source text or user instructions.

**Tech Stack:** TypeScript, VS Code extension API, Node test runner, existing `extension/test/review.cjs` and `extension/test/panel.cjs` harnesses.

**Spec:** `docs/superpowers/specs/2026-11-20-hybrid-retrieval-efficiency-design.md`

## Global Constraints

- Each accepted hunk remains bound to the current proposal identity and base SHA-256.
- Rejected hunks are never applied; no AI proposal may write before user approval.
- Undo must continue restoring the exact reviewed original text.
- Review buttons and the picker exist only while an edit review is pending.
- Do not claim 2× improvement unless paired manual measurements show it and safety outcomes remain unchanged.

## Review Focus

- A review is cancelled while the diff is open: close the picker and remove its actions.
- A command approval is open instead of an edit review: review controls must not answer the command prompt.
- A proposal becomes stale before acceptance: the existing base-hash validation must still refuse the write.
- A multi-hunk proposal is partly selected: the per-hunk picker must preserve every individual choice.
- Undo is invoked after a reviewed change: the exact reviewed text is restored.

---

### Task 1: Direct hunk picker

**Files:**
- Modify: `extension/src/inlineReview.ts`
- Test: `extension/test/review.cjs`
- Test: `extension/test/panel.cjs`

**Interfaces:**
- Consumes: existing `InlineReview.decideAll(choice)` and registered commands `forgeathon.acceptAllHunks` / `forgeathon.rejectAllHunks`.
- Produces: a single picker with per-hunk multi-select and top-level Accept All / Reject All buttons.

- [x] **Step 1: Add extension tests asserting the single picker exposes every hunk and Accept All / Reject All actions, closes after accept, reject, cancel, and errors, and preserves partial hunk choices. Test that deciding one hunk removes one picker action compared with the existing nested flow.**
- [x] **Step 2: Run `scripts/test-extension.sh`; expected: direct-picker and action-count assertions fail before the UI change.**
- [x] **Step 3: Replace the initial action QuickPick and secondary hunk QuickPick in `InlineReview` with one `canSelectMany` picker; implement top-level buttons that call existing `decideAll` and preserve partial selection behavior.**
- [x] **Step 4: Keep the existing command palette and status-bar review actions available; the direct picker must not change command approval behavior.**
- [x] **Step 5: Run `scripts/test-extension.sh`; expected: partial-hunk, stale-base, and undo cases remain green, and each selected hunk requires one final submission action.**
- [x] **Step 6: Record paired reviews of the same multi-hunk change with old/new UI.** Automated action-count test: two picker submissions before, one after. No human timing was collected, so no timed speed claim is made; see ruling in the SDD ledger.
- [x] **Step 7: Commit the review controls (`032fbc4`).**
