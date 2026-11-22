# Round-one capability benchmarks

This note gathers the before/after evidence for the five technical capabilities. A percentage below applies only to the named measurement; preview correctness, edit footprint, model-run latency, retrieval quality, and cancel acknowledgement are different metrics.

The values below come from benchmark results already recorded in the repository and the before/after cancellation run from this work. The extension-host checks were not rerun while assembling this note: `scripts/test-extension.sh` could not start because this environment has no `apt-get` for its VS Code test runtime setup. The inline-preview and hunk-footprint values are therefore recorded results, not fresh measurements from this pass.

## Results

| Capability | Before | After | Change and meaning |
|---|---|---|---|
| Inline edit with an in-editor diff | A static two-hunk diff matched the checked choices in 1 of 4 possible accept/reject states (25%). | The live preview matched all 4 of 4 states (100%). | 4× the preview-state coverage (+75 percentage points). This measures whether the displayed proposed text matches the checked hunks, not review time. |
| Agent discovers and edits at least three files | Archived real-model Task B: one QA run on `37fb675` took 105.5 s to first diff and 160.3 s total; another recorded run used 47 model requests and took 204.5 s. | Three real-model Task B runs on `f2f87bb` all passed 6/6 checks and changed the required three files. Their medians were 52.4 s to first diff, 113.5 s total, and 25 requests. | Against the 47-request / 204.5 s run: 46.8% fewer requests and 44.5% shorter turn. Against the 105.5 s first-diff run: 50.3% shorter time to first diff. Historical runs differ in settings and model variability, so these are directional comparisons, not a paired A/B result. |
| Explicit and automatic context selection | At 4,000 tokens: recall@5 0.699; MRR 0.660; relevant-file density 0.461 per 1,000 packed tokens; 9/30 expected files packed; 4.55 ms median assembly. | At 4,000 tokens: recall@5 0.801; MRR 0.733; density 0.492; 25/30 expected files packed; 4.04 ms median assembly. | Recall +14.7%; MRR +11.2%; density +6.7%; 16 more expected files packed; assembly latency 11.1% lower. The 13-task baseline is a single run, while current values use three runs. Semantic inference was disabled to isolate lexical/structural retrieval. |
| Per-hunk review and undo | The previous whole-document replacement would submit 375,756 characters of ranges and replacement text in the large-file test. | Hunk-level apply plus undo submits 116 characters in the same 93,936-character file. | 99.97% less editor edit payload. This measures edit scope, not CPU time or human review time. |
| Streaming and consistent cancellation | Median cancel RPC reply: 13 ms during streaming and 18 ms during a running command. Median stream request-to-terminal event: 14 ms. | Median cancel RPC reply: 1 ms for both cases. Median stream request-to-terminal event: 12 ms. | RPC reply is 92.3% faster during streaming and 94.4% faster during a command. Request-to-terminal time is 14.3% lower. An already approved write still settles and is reported before `done`; the integration test deliberately delays that write by 1.5 s. |

### Context at 8,000 tokens

This is a separate budget comparison: the earlier single-run baseline measured recall@5 0.699, MRR 0.660, density 0.244, and 203.16 ms median assembly; the current three-run result measured 0.801, 0.733, 0.315, and 4.06 ms. The assembly latency is 98.0% lower. The old baseline waited on a cold/missing semantic runtime, and the indexed source trees differed slightly. Semantic ranking quality itself was not measured.

### Agent-run detail

The three current Task B runs used the real NVIDIA-hosted model and recorded 25, 27, and 25 requests; first-diff times were 52.4, 31.2, and 52.7 s; total turn times were 124.2, 91.8, and 113.5 s. Each passed 6/6 checks and changed `src/flask/cli.py`, `tests/test_cli.py`, and `docs/cli.rst`. This demonstrates repeated task success; it does not establish a controlled model-latency benchmark. The scripted-model tests supply their own file paths and therefore do not prove discovery.

### Cancellation samples

These five-run samples produce the medians in the results table (milliseconds):

| Measurement | Before | After |
|---|---|---|
| Cancel RPC reply during streaming | 25, 13, 13, 11, 14 | 1, 1, 1, 1, 1 |
| Cancel RPC reply during a running command | 16, 23, 14, 22, 18 | 1, 1, 1, 1, 2 |
| Streaming request to terminal event | 25, 14, 14, 12, 14 | 12, 14, 12, 15, 10 |

The first two rows measure how quickly the cancel request is acknowledged. The last row measures how quickly the stream reaches its terminal event. The delayed in-flight write is a separate consistency case: it takes about 1.58 s to settle, and the test checks that the write receipt comes before `done`.

## How to reproduce

- Context retrieval and packing: `node scripts/bench-context.mjs --mode hybrid --budget-tokens 4000` (the labeled Flask cases require `FORGE_FLASK_DIR`).
- Harness cancellation and workspace settlement: `npm --prefix src/harness run test:integration` with the local TrueForge demo running.
- Inline preview and per-hunk apply/undo: `scripts/test-extension.sh` and `scripts/test-extension-live.sh` in an environment with the VS Code test runtime and display dependencies.
- Real-model multi-file Task B: `scripts/smoke-real-model.mjs --tasks B`, with the configured model profile and a fresh test workspace. Model service, prompt, and rate-limit variability affect these results.

## Evidence and limitations

- Inline-preview and edit-footprint measurements are from the extension-host benchmark described in [README.md](../README.md#safety-model).
- Context measurements and their baseline caveats are in [README.md](../README.md#context-selection-benchmark).
- Real-model task results are in [rehearsal.json](writeup/rehearsal.json), [STATUS.md](STATUS.md), and [DEMO-SCRIPT.md](DEMO-SCRIPT.md).
- Cancellation correctness is checked by [turn.itest.ts](../src/harness/integration/turn.itest.ts); the delayed-write result and integration-suite status are recorded in the [cancellation implementation note](superpowers/plans/2026-11-20-streaming-cancellation-efficiency.md). The raw latency samples above are from the five-run before/after timing capture.

The 50% target is not met on every metric. It is exceeded for inline-preview state coverage, 8,000-token assembly latency, and cancel-RPC acknowledgement. The 4,000-token retrieval metrics, per-hunk review time, and terminal `done` latency do not show a 50% improvement. Task B's saved runs show substantial directional gains in requests and turn time, but are not paired trials.
