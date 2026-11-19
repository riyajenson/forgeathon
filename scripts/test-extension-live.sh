#!/usr/bin/env bash
# Opt-in native UI rehearsal (extension/test/live.cjs): a real VS Code window with a DevTools port, its own
# loopback TrueForge 0.185.1 and the scripted model. Drives the inline command, the native diff and the hunk
# picker by clicking, then checks what was saved and that Undo restores the file. No keys, no network.
# Usage: scripts/test-extension-live.sh
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
cli="${FORGE_TEST_TRUEFORGE_CLI:-}"
if [ -z "$cli" ]; then
  npx -y @truefoundry/trueforge@0.185.1 --version >/dev/null 2>&1 || true   # populate the npx cache
  cli="$(ls -d "$HOME"/.npm/_npx/*/node_modules/@truefoundry/trueforge 2>/dev/null | while read -r d; do
    node -e "process.exit(require('$d/package.json').version==='0.185.1'?0:1)" && echo "$d/dist/cli.js"; done | head -1)"
fi
[ -f "$cli" ] || { echo "TrueForge 0.185.1 CLI not found; set FORGE_TEST_TRUEFORGE_CLI" >&2; exit 2; }
(cd "$repo/src/harness" && npm run build >/dev/null)
work="$(mktemp -d /tmp/forge-live-XXXXXX)"
mkdir -p "$work/workspace" "$work/profile"
trap 'rm -rf "$work"' EXIT
export FORGE_TEST_CDP_PROFILE="$work/profile" FORGE_TEST_TRUEFORGE_CLI="$cli" FORGE_TEST_NODE="$(command -v node)" \
  FORGE_EDH_WORKSPACE="$work/workspace"
cd "$work"   # @vscode/test-electron derives scratch paths from the working directory; keep them out of the checkout
"$repo/scripts/test-extension.sh" live.cjs
