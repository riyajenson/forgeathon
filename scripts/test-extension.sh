#!/usr/bin/env bash
# Runs the extension's tests in a real VS Code window (WSLg or any X/Wayland display).
# VS Code's Linux build needs libnspr4, libnss3 and libasound2; when they are missing this script fetches
# them with `apt-get download` (no sudo) into ~/.cache/forge-vscode-libs and uses LD_LIBRARY_PATH.
# Usage: scripts/test-extension.sh [test file under extension/test, default panel.cjs]
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
libs="${FORGE_VSCODE_LIBS:-$HOME/.cache/forge-vscode-libs}"

if [ -z "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
  echo "No display (DISPLAY/WAYLAND_DISPLAY). On Windows 11, WSLg provides one." >&2
  exit 2
fi

need_libs=0
for lib in libnspr4.so libnss3.so libasound.so.2; do
  ldconfig -p 2>/dev/null | grep -q "$lib" || need_libs=1
done
if [ "$need_libs" = 1 ]; then
  if [ ! -f "$libs/usr/lib/x86_64-linux-gnu/libnss3.so" ]; then
    echo "Fetching VS Code runtime libraries into $libs (no sudo)"
    mkdir -p "$libs/debs"
    (cd "$libs/debs" && apt-get download libnspr4 libnss3 libasound2t64 >/dev/null)
    for deb in "$libs"/debs/*.deb; do dpkg-deb -x "$deb" "$libs"; done
  fi
  export LD_LIBRARY_PATH="$libs/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fi

cd "$repo/extension"
npm run compile >/dev/null
node test/run-edh.cjs "${1:-panel.cjs}" 2>&1 | grep -vE 'Gtk|dbus|Fontconfig|libva|MESA|Xlib|ERROR:(viz|gpu)|ozone|vaapi|GLib|AgentHost|^\s*$'
exit "${PIPESTATUS[0]}"
