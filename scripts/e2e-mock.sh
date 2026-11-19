#!/usr/bin/env bash
# End-to-end check without a GUI and without model keys: scripted demo model + fresh TrueForge + setup,
# then Tasks A, B and C through createHarness on a temporary copy of pristine Flask 3.1.3, with the
# task verifications (Task A one-liner, pytest tests/test_cli.py -q, flask --help, masked flask config,
# Task C fallback + clean git status), and Task G: the guardrails (command budget, argument-shape hint).
# Exits non-zero if any check fails.
# Usage: scripts/e2e-mock.sh [--flask ~/flask-demo (default; else ~/projects/flask-3.1.3)] [--tasks A,B,G,C]
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
(cd "$repo/src/harness" && npm run build >/dev/null)
"$repo/scripts/dev-mock.sh" --background
trap '"$repo/scripts/dev-mock.sh" stop' EXIT
export FORGE_MOCK_PRIMARY_KEY="itest-good-key" FORGE_MOCK_FALLBACK_KEY="itest-good-key"
# Caller arguments come first: the smoke script uses the first occurrence of each option.
node "$repo/scripts/smoke-real-model.mjs" "$@" --config "$repo/config/models.mock.example.json" --tasks A,B,G,C
