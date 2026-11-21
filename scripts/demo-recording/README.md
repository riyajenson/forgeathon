# Demo recording tooling

How the demo video's VS Code footage is recorded: a script drives the real Extension Development Host, with real
models, at human pace (real typing, real pointer moves and clicks), while a DevTools screencast saves every frame.
Nothing is simulated: the extension, the harness, TrueForge and the models run as in normal use. These scripts are
not part of the default install; their only dependency is `playwright-core` (it connects to the running VS Code
over its DevTools port and downloads no browser).

```bash
cd scripts/demo-recording && npm install        # playwright-core 1.49.1, once
./launch-vscode.sh                              # VS Code on ~/flask-demo with the recording profile, DevTools port 9333
node screencast.cjs ~/forge-demo/raw &          # frames/*.jpg + index.tsv until SIGTERM
node drive.cjs layout ~/forge-demo/raw/markers.jsonl
node drive.cjs A      ~/forge-demo/raw/markers.jsonl
node drive.cjs B      ~/forge-demo/raw/markers.jsonl   # includes Bverify (terminal checks, TrueForge session link)
scripts/use-models.sh nvidia-free --break-primary     # from the repo root, for Task C
node drive.cjs C      ~/forge-demo/raw/markers.jsonl
scripts/use-models.sh nvidia-free                     # restore the primary model
```

Before each take, reset the workspace (`git -C ~/flask-demo checkout -- . && git -C ~/flask-demo clean -fd`) and
start TrueForge with the models set up (README, Quickstart). `FORGE_DEMO_WORKSPACE`, `FORGE_DEMO_CDP_PORT` and
`FORGE_DEMO_PROFILE` override the defaults; `FORGE_DEMO_CANCEL_TASK` replaces the instruction the `cancel` step
sends (with the scripted model of `scripts/dev-mock.sh`, use `stop check: pending review`, the only turn it can be
stopped in). Each step appends JSON-line markers (`instruction_sent`, `first_diff`,
`accepted`, `cmd_prompt`, `seg_end`, ...) with epoch timestamps, so cuts can be placed against `index.tsv`. A
failed step saves a screenshot next to the markers file. `drive.cjs Bresume` continues an interrupted Task B turn
(`REVIEWS_SO_FAR=<n>` keeps the review count); `drive.cjs state` prints what the quick input and the panel show.

How the driver answers prompts, as a user would:

- **Reviews:** every diff opens the multi-select hunk picker. Task A shows unchecking and rechecking the last hunk,
  then submits with Enter; Task B clicks the picker's ✓ (*Accept all hunks*) title button; Task C clicks ✕
  (*Reject all hunks*). The pointer rests on the button so its tooltip is on screen, then clicks the button's
  coordinates: a locator click would wait for the button to receive pointer events, which the tooltip it just
  opened can intercept.
- **Commands:** *Allow once* for listed commands and *Deny* for ⚠ Unrestricted ones. When the row is in the list
  but not rendered as visible (it can be, under the prompt's long detail text), it is selected with the keyboard
  (Home, arrows, Enter) instead of waiting for a hover that cannot happen.
