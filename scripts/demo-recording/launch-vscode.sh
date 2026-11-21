#!/usr/bin/env bash
# Starts the Extension Development Host for recording: the VS Code build the extension tests downloaded, this
# checkout's extension, a separate recording profile (large fonts, dark theme, no minimap, AI chat features off,
# auto-approval of the listed test commands on) and a DevTools port that drive.cjs and screencast.cjs connect to.
# URLs the extension opens (the TrueForge session link) are appended to $FORGE_DEMO_PROFILE/opened-urls.txt
# instead of opening a browser, so the recording stays on VS Code.
#
# usage: scripts/demo-recording/launch-vscode.sh
# env:   FORGE_DEMO_WORKSPACE (default ~/flask-demo, a Flask 3.1.3 copy with .venv), FORGE_DEMO_CDP_PORT (9333),
#        FORGE_DEMO_PROFILE (default ~/.cache/forge-demo-profile; deleted and recreated on every launch)
set -euo pipefail
repo="$(cd "$(dirname "$0")/../.." && pwd)"
workspace="${FORGE_DEMO_WORKSPACE:-$HOME/flask-demo}"
port="${FORGE_DEMO_CDP_PORT:-9333}"
profile="${FORGE_DEMO_PROFILE:-$HOME/.cache/forge-demo-profile}"
code="$(ls -d "$repo"/extension/.vscode-test/vscode-linux-x64-*/code "$HOME"/.cache/forge-vscode/vscode-linux-x64-*/code 2>/dev/null | tail -1)"
[ -x "$code" ] || { echo "VS Code test build not found: run scripts/test-extension.sh once (it downloads it)" >&2; exit 2; }
[ -d "$workspace/.venv" ] || { echo "$workspace/.venv missing: the demo terminal activates it" >&2; exit 2; }

pkill -f -- "--user-data-dir=$profile" 2>/dev/null && sleep 2 || true
rm -rf "$profile"; mkdir -p "$profile/User" "$profile/exts"
cat > "$profile/User/settings.json" <<EOF
{
 "editor.fontSize": 16, "terminal.integrated.fontSize": 15, "window.zoomLevel": 1,
 "editor.minimap.enabled": false, "workbench.startupEditor": "none", "workbench.tips.enabled": false,
 "forge.autoApproveSafeCommands": true, "security.workspace.trust.enabled": false,
 "window.newWindowDimensions": "maximized", "window.restoreWindows": "none",
 "workbench.colorTheme": "Default Dark Modern", "update.mode": "none", "telemetry.telemetryLevel": "off",
 "extensions.ignoreRecommendations": true, "git.openRepositoryInParentFolders": "never",
 "terminal.integrated.cwd": "$workspace", "chat.commandCenter.enabled": false,
 "workbench.layoutControl.enabled": false, "editor.accessibilitySupport": "off", "chat.disableAIFeatures": true,
 "window.commandCenter": false, "github.copilot.enable": {"*": false}, "terminal.integrated.enablePersistentSessions": false,
 "python.terminal.activateEnvironment": false, "editor.inlineSuggest.enabled": false, "workbench.editor.enablePreview": false
}
EOF
cat > "$profile/browser.sh" <<EOF
#!/bin/sh
echo "\$(date +%s.%N) \$1" >> "$profile/opened-urls.txt"
EOF
chmod +x "$profile/browser.sh"

libs="${FORGE_VSCODE_LIBS:-$HOME/.cache/forge-vscode-libs}/usr/lib/x86_64-linux-gnu"
[ -d "$libs" ] && export LD_LIBRARY_PATH="$libs${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export BROWSER="$profile/browser.sh"
(cd "$repo/extension" && npm run -s compile)
cd "$workspace"
setsid nohup "$code" --extensionDevelopmentPath="$repo/extension" --user-data-dir="$profile" --extensions-dir="$profile/exts" \
  --disable-workspace-trust --skip-welcome --remote-debugging-port="$port" --new-window "$workspace" > "$profile/vscode.log" 2>&1 &
for _ in $(seq 30); do curl -s "127.0.0.1:$port/json/list" | grep -q workbench && break; sleep 1; done
curl -s "127.0.0.1:$port/json/list" | grep -q workbench || { echo "VS Code did not open a DevTools port on $port (log: $profile/vscode.log)" >&2; exit 1; }
sleep 4; echo "VS Code is up (DevTools port $port, profile $profile)"
