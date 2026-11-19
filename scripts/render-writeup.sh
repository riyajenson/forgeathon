#!/usr/bin/env bash
# Renders docs/writeup/WRITEUP.md to docs/writeup/WRITEUP.pdf with md-to-pdf (headless Chromium via npx).
# On WSL without Chromium's system libraries, it reuses the libraries fetched by scripts/test-extension.sh
# (no sudo). Prints the page count; the PDF must be 1-3 pages.
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
libs="${FORGE_VSCODE_LIBS:-$HOME/.cache/forge-vscode-libs}"
if ! ldconfig -p 2>/dev/null | grep -q libnss3.so; then
  if [ ! -f "$libs/usr/lib/x86_64-linux-gnu/libnss3.so" ]; then
    mkdir -p "$libs/debs"
    (cd "$libs/debs" && apt-get download libnspr4 libnss3 libasound2t64 >/dev/null)
    for deb in "$libs"/debs/*.deb; do dpkg-deb -x "$deb" "$libs"; done
  fi
  export LD_LIBRARY_PATH="$libs/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fi
cd "$repo/docs/writeup"
npx --yes md-to-pdf@5 WRITEUP.md >/dev/null
pages="$(python3 -c "import re,sys; print(len(re.findall(rb'/Type\s*/Page[^s]', open('WRITEUP.pdf','rb').read())))")"
echo "docs/writeup/WRITEUP.pdf: $pages page(s)"
