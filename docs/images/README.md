# Screenshots for the README

No images are committed yet. Take them from the real-model recording session (not the mock model). Save them
here as PNG, about 1600 px wide, cropped to the relevant part of the window, with no keys, tokens or personal
paths visible. Then uncomment the matching `![…](docs/images/…)` lines in the README's "Demo" section.

| File | Shot | When |
|---|---|---|
| `inline-review.png` | Task A: the diff editor for `src/flask/helpers.py` with the "Review N hunks" notification or the per-hunk picker open | After the inline instruction, before accepting |
| `agent-panel-context.png` | Task B: the agent panel with the **Context** block expanded (used/budget line, `src/flask/cli.py` first with its rationale, the Skipped list) and the first tool calls | While the first diff is being prepared |
| `fallback-banner.png` | Task C: the panel or notification "Primary model failed: [Model Error] Request failed (401): Unauthorized → switched to groq/qwen3-8-27b" next to the fallback's diff | After repeating Task A with the broken primary key |
