#!/usr/bin/env bash
# Starts the Extension Development Host for recording: the VS Code build the extension tests downloaded, this
# checkout's extension, a separate recording profile (large fonts, dark theme, no minimap, AI chat features off,
# auto-approval of the listed test commands on) and a DevTools port that drive.cjs and screencast.cjs connect to.
# URLs the extension opens (the TrueForge session link) are appended to $FORGE_DEMO_PROFILE/opened-urls.txt
# instead of opening a browser, so the recording stays on VS Code. VS Code opens links with xdg-open on Linux, so a
# stand-in xdg-open that only logs the URL goes first on its PATH ($BROWSER points at the same script).
#
# usage: scripts/demo-recording/launch-vscode.sh
# env:   FORGE_DEMO_WORKSPACE (default ~/flask-demo, a Flask 3.1.3 copy with .venv), FORGE_DEMO_CDP_PORT (9333),
#        FORGE_DEMO_PROFILE (default ~/.cache/forge-demo-profile; deleted and recreated on every launch)
set -euo pipefail
repo="$(cd "$(dirname "$0")/../.." && pwd)"
workspace="${FORGE_DEMO_WORKSPACE:-$HOME/flask-demo}"
port="${FORGE_DEMO_CDP_PORT:-9333}"
profile="${FORGE_DEMO_PROFILE:-$HOME/.cache/forge-demo-profile}"
shopt -s nullglob
builds=("$repo"/extension/.vscode-test/vscode-linux-x64-*/code "$HOME"/.cache/forge-vscode/vscode-linux-x64-*/code)
shopt -u nullglob
code="${builds[${#builds[@]}-1]:-}"
[ -n "$code" ] && [ -x "$code" ] || { echo "VS Code test build not found: run scripts/test-extension.sh once (it downloads it)" >&2; exit 2; }
[ -d "$workspace/.venv" ] || { echo "$workspace/.venv missing: the demo terminal activates it" >&2; exit 2; }

# Close a previous recording window and wait until it has gone and released the DevTools port. VS Code does not
# always quit on the first SIGTERM, so it is repeated every 2 s, and SIGKILL is the last resort after 15 s.
for i in $(seq 30); do
  if ! pgrep -f -- "--user-data-dir=$profile" >/dev/null && ! curl -s -o /dev/null "127.0.0.1:$port/json/version"; then break; fi
  if [ "$i" -eq 30 ]; then pkill -KILL -f -- "--user-data-dir=$profile" 2>/dev/null || true; sleep 1
  elif [ $((i % 4)) -eq 1 ]; then pkill -f -- "--user-data-dir=$profile" 2>/dev/null || true; fi
  sleep 0.5
done
if curl -s -o /dev/null "127.0.0.1:$port/json/version"; then echo "DevTools port $port is still in use" >&2; exit 1; fi
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
mkdir -p "$profile/bin"
cat > "$profile/bin/xdg-open" <<EOF
#!/bin/sh
echo "\$(date +%s.%N) \$1" >> "$profile/opened-urls.txt"
EOF
chmod +x "$profile/bin/xdg-open"

libs="${FORGE_VSCODE_LIBS:-$HOME/.cache/forge-vscode-libs}/usr/lib/x86_64-linux-gnu"
[ -d "$libs" ] && export LD_LIBRARY_PATH="$libs${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export BROWSER="$profile/bin/xdg-open" PATH="$profile/bin:$PATH"
(cd "$repo/extension" && npm run -s compile)
cd "$workspace"
setsid nohup "$code" --extensionDevelopmentPath="$repo/extension" --user-data-dir="$profile" --extensions-dir="$profile/exts" \
  --disable-workspace-trust --skip-welcome --remote-debugging-port="$port" --new-window "$workspace" > "$profile/vscode.log" 2>&1 &
for _ in $(seq 30); do curl -s "127.0.0.1:$port/json/list" | grep -q workbench && break; sleep 1; done
curl -s "127.0.0.1:$port/json/list" | grep -q workbench || { echo "VS Code did not open a DevTools port on $port (log: $profile/vscode.log)" >&2; exit 1; }
sleep 4; echo "VS Code is up (DevTools port $port, profile $profile)"
