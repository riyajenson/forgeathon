#!/usr/bin/env bash
# Live end-to-end test of the extension UI in a real VS Code window: demo mode (scripted model + fresh
# TrueForge), a temporary copy of pristine Flask 3.1.3 as the workspace, then Tasks A, B, Stop and C driven
# through the extension's Workbench (extension/test/tasks.cjs).
# Usage: scripts/test-extension-e2e.sh [--flask ~/projects/flask-3.1.3]
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
flask="$HOME/projects/flask-3.1.3"
[ "${1:-}" = "--flask" ] && flask="$2"

(cd "$repo/src/harness" && npm run build >/dev/null)
work="$(mktemp -d /tmp/forge-ui-e2e-XXXXXX)"
cp -r "$flask" "$work/flask"
echo "virtualenv for the workspace (flask -e, pytest==9.0.2)"
python3 -m venv "$work/venv" && "$work/venv/bin/pip" install -q -e "$work/flask" "pytest==9.0.2"

"$repo/scripts/dev-mock.sh" --background
trap '"$repo/scripts/dev-mock.sh" stop; rm -rf "$work"' EXIT

export PATH="$work/venv/bin:$PATH" VIRTUAL_ENV="$work/venv" FORGE_EDH_WORKSPACE="$work/flask"
"$repo/scripts/test-extension.sh" "${FORGE_E2E_TEST:-tasks.cjs}"
