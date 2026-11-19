# Project status

Updated: 2026-11-19 10:20 IST (Phase 0). Owner while you are away: harness + editor + contracts + docs.

## MVP checklist

Legend: ✅ verified (how) · 🟡 implemented, not yet verified end to end · ❌ missing

| Item | Status | Evidence / gap |
|---|---|---|
| Task A: inline edit (select, Ctrl+Alt+I, instruction) | 🟡 | Harness: headless inline rehearsal against TrueForge + mock passes. Extension: compiles; not yet run in a VS Code window |
| Task A: per-hunk diff + accept/reject | 🟡 | Diff editor + Accept All / Reject All / Choose Hunks (extension); harness partial-accept tests pass |
| Task A: undo | 🟡 | `Forge-a-thon: Undo Last Reviewed Edit`, guarded by post-edit hash; not run in a window |
| Task B: panel streaming + tool calls | 🟡 | Panel implemented; harness streaming tested; no realistic Task B mock script yet |
| Task B: context block (used/budget, reasons, skipped) | 🟡 | Engine + panel implemented; cli.py ranks #5 for Task B |
| Task B: ≥3 files, per-hunk review | ❌ | Needs a mock Task B script and an end-to-end run |
| Task C: invalid primary → fallback banner, workspace unchanged | 🟡 | Harness integration tests pass (401 → fallback); banner implemented |
| Cancel: Stop ends turn, review closes, no partial edits | 🟡 | Harness cancel tests pass; editor Stop implemented |
| TrueForge session link | 🟡 | `session` event → panel button |
| Demo-without-keys mode (`scripts/dev-mock.sh`) | ❌ | Phase 1 |
| Automated end-to-end check on Flask copy | ❌ | Phase 1 |

## Branch map

`main` = `1317300` (pushed). Everything below is merged into it.

| Branch | Content |
|---|---|
| docs/branching | branching and commit convention |
| contracts/v0.4.0 → v0.4.1 | shared contracts (protocol 0.4.1) |
| harness/p0-spike | TrueForge 0.185.1 spike + findings |
| harness/p1-review-mcp → p2a-turn-runner → p3-agents-setup → p4-context-engine → p5-smoke | harness |
| editor/e1-scaffold → e2 → e3 → e4 → e5-review-actions | VS Code extension |

New work today goes on new branches (`harness/p6-*`, `editor/e6-*`, `docs/*`) merged locally into main with `--no-ff`.

## Decisions made (today)

1. No model keys in the environment: no real-model runs; everything is developed and tested against the scripted mock model.

## Needs human

(none yet)
