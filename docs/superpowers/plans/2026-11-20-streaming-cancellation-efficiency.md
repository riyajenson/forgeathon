# Streaming and Cancellation Efficiency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make control and approval events visible within one webview animation frame, improving their current 40 ms refresh delay by at least 2×, while retaining cancellation and workspace-consistency guarantees.

**Architecture:** Keep the sequenced TrueForge event stream unchanged. Coalesce replaceable text deltas at a 16 ms display cadence, but send status, approval, error, edit-applied, and terminal state immediately. Measure event-to-animation-frame and Stop-to-final-event locally; preserve the existing in-flight-write settlement logic.

**Tech Stack:** TypeScript, Node.js, VS Code Webview API, browser `requestAnimationFrame` / `performance.now()`, existing Node and VS Code test harnesses.

**Spec:** `docs/superpowers/specs/2026-11-20-hybrid-retrieval-efficiency-design.md`

## Global Constraints

- Do not reorder, drop, or renumber canonical `HarnessEvent` sequence entries.
- Text display may be coalesced; control, review, command, error, edit-applied, fallback, and `done` events may not.
- Cancellation closes pending approvals, aborts commands, and waits for any submitted VS Code write to settle before terminal state.
- Exactly one `done` event remains the final event for a turn.
- Workspace effects after cancellation must be reported accurately; no retry/fallback starts while a tool is unsettled.

## Review Focus

- Text delta bursts arrive faster than one frame: display every character in order after coalescing.
- A review or command request arrives while a text flush is queued: show the control immediately and keep all earlier text.
- Stop occurs during pending review: retire the review controls, cancel the turn, and emit one final cancelled state.
- Stop occurs after an edit is submitted to VS Code: wait for save/report before terminal state; never claim no change.
- Webview closes during a turn: avoid posting to a disposed panel while the harness still settles safely.

---

### Task 1: Separate text refreshes from control refreshes

**Files:**
- Modify: `extension/src/agentPanel.ts`
- Modify: `extension/media/agent.js`
- Test: `extension/test/responsiveness.cjs`
- Test: `extension/test/panel.cjs`

**Interfaces:**
- Consumes: existing `AgentPanel.event(e)` and `AgentViewState.update(e)`.
- Produces: `refreshText()` coalescing only text events at 16 ms and `refreshControl()` posting control state immediately; an internal render sequence and `rendered` acknowledgement after the next webview animation frame.

- [x] **Step 1: Add tests for ordered text display after coalescing, immediate control rendering during a pending text flush, and safe refresh after the webview closes.**
- [x] **Step 2: Run `scripts/test-extension.sh`; expected: latency/order tests fail under the current generic 40 ms timer.**
- [x] **Step 3: Route `text` events through a 16 ms coalescer; route every other event through immediate control refresh. Keep the existing state snapshot and event sequence unchanged.**
- [x] **Step 4: Acknowledge each render sequence from `agent.js` after `requestAnimationFrame`; measure event-to-animation-frame p50/p95 without logging message text or source code.**
- [x] **Step 5: Run `scripts/test-extension.sh`; verify text order, immediate controls, and numeric latency summaries in the deterministic panel test. The real Task B responsiveness run asserts control event-to-frame p95 <=20 ms and text p95 <=40 ms when its Flask checkout is available.**
- [x] **Step 6: Commit the streaming update (`0ab8b39`).**

### Task 2: Measure and preserve cancellation settlement

**Files:**
- Test: `src/harness/integration/turn.itest.ts`
- Test: `extension/test/responsiveness.cjs`

**Interfaces:**
- Consumes: existing cancellation request, `SessionScope.settle()`, sequenced event buffer, and `done` event.
- Produces: a test-only measurement of Stop-to-terminal time in the no-pending-write case, plus race coverage for in-flight writes; no production protocol fields or event sequencing changes.

- [x] **Step 1: Cover Stop during streaming, pending review, command execution, before spawn, and after VS Code accepted a write. Assert one terminal event and exact expected workspace effect in each case.**
- [x] **Step 2: Run focused integration and extension tests; the no-pending-write measurement establishes the current baseline and settlement assertions exercise the existing safety path.**
- [x] **Step 3: Keep production cancellation and settlement code unchanged.**
- [x] **Step 4: Run `npm --prefix src/harness run test:integration`, `npm --prefix src/harness test`, and `scripts/test-extension.sh`; verify workspace effects and one final `done`.**
- [x] **Step 5: Commit cancellation measurements and regression coverage (`d0cba2a`).**

**Verification note:** The streaming cancel request reached final `done` in 12 ms; the workspace remained unchanged. Cancelling an approved running `sleep 30` command also reached final `done` in 12 ms and left the workspace unchanged. The in-flight apply case waited about 1.58 s for the submitted write and reported it before `done`. The extension panel suite passed; the harness unit suite passed 149 tests with one Flask-checkout-dependent skip; integration passed 20/20. Commits: `0ab8b39` (streaming), `d0cba2a` (cancellation). The real Task B responsiveness run is unavailable because `/home/xtrmn8/flask-demo` is absent; the test now asserts real-webview event-to-animation-frame sample counts and p95 limits when that checkout is available.
