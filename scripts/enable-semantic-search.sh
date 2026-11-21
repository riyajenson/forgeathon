#!/usr/bin/env bash
# Opt-in runtime for forge.context.semanticSearch (local semantic reranking, off by default).
# Installs the pinned @huggingface/transformers runtime (src/harness/semantic-runtime/package-lock.json) next to
# the harness, CPU-only: ONNX Runtime's optional CUDA/TensorRT download is skipped. A default install never
# runs this, so the harness stays small. The embedding model itself (about 54 MB) is downloaded from Hugging
# Face on the first semantic search, into ~/.cache/forgeathon/transformers.
# Usage: scripts/enable-semantic-search.sh            install (or reinstall) the runtime
#        scripts/enable-semantic-search.sh --remove   delete it again (semantic search then falls back to lexical)
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
runtime="$repo/src/harness/semantic-runtime"
if [[ "${1:-}" == "--remove" ]]; then
  rm -rf "$runtime/node_modules"
  echo "semantic search runtime removed; with forge.context.semanticSearch on, ranking stays lexical"
  exit 0
fi
ONNXRUNTIME_NODE_INSTALL=skip npm ci --prefix "$runtime" --no-audit --no-fund
# onnxruntime-node ships prebuilt binaries for every OS and CPU; keep only this machine's.
node -e '
const fs = require("node:fs"), path = require("node:path");
const bin = path.join(process.argv[1], "node_modules", "onnxruntime-node", "bin");
for (const napi of fs.existsSync(bin) ? fs.readdirSync(bin) : []) {
  for (const os of fs.readdirSync(path.join(bin, napi))) {
    const osDir = path.join(bin, napi, os);
    if (os !== process.platform) { fs.rmSync(osDir, { recursive: true, force: true }); continue; }
    for (const arch of fs.readdirSync(osDir)) if (arch !== process.arch) fs.rmSync(path.join(osDir, arch), { recursive: true, force: true });
  }
}' "$runtime"
node -e "require(require('node:module').createRequire('$runtime/package.json').resolve('@huggingface/transformers'))" \
  || { echo "the runtime installed but does not load; see the npm output above" >&2; exit 1; }
echo "semantic search runtime installed in $runtime ($(du -sh "$runtime/node_modules" | cut -f1)), CPU only"
echo "turn it on in VS Code: \"forge.context.semanticSearch\": true"
