#!/usr/bin/env bash
# Daytona spike (opt-in; not part of setup, the mock or Tasks A/B/C): a fresh TrueForge 0.185.1 on :8792 with its
# own database, the Daytona sandbox provider, one git skill and Code Mode, driven by the scripted model.
# Needs .env.daytona (DAYTONA_API_KEY=...) in the repo root; the key is read only by the spike process and is
# never printed. Daytona sandboxes stop after 5 idle minutes and are deleted 10 minutes after stopping.
#
#   scripts/daytona-spike.sh [OUT_DIR]      (default ~/forge-review/finals/daytona-spike)
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
out="${1:-$HOME/forge-review/finals/daytona-spike}"
port="${SPIKE_TF_PORT:-8792}"
keyfile="$repo/.env.daytona"
[ -f "$keyfile" ] || { echo "missing $keyfile (DAYTONA_API_KEY=...)" >&2; exit 1; }
grep -q '^DAYTONA_API_KEY=.' "$keyfile" || { echo "$keyfile has no DAYTONA_API_KEY" >&2; exit 1; }
mkdir -p "$out"
(cd "$repo/src/harness" && npm run build >/dev/null)

db="$out/trueforge-$(date +%Y%m%d-%H%M%S).sqlite"
HOST=127.0.0.1 OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1"]' MODEL_HTTP_CONNECT_TIMEOUT_MS=3000 SQLITE_PATH="$db" \
  setsid npx -y @truefoundry/trueforge@0.185.1 --port "$port" > "$out/trueforge.log" 2>&1 &
tf=$!
trap 'kill -- "-$tf" 2>/dev/null || kill "$tf" 2>/dev/null || true' EXIT
echo -n "waiting for TrueForge on :$port"
for _ in $(seq 1 120); do curl -sf -o /dev/null --max-time 2 "http://127.0.0.1:$port/healthz" && break; echo -n .; sleep 1; done
echo

# The key reaches only this process (not TrueForge's environment, not the shell history).
status=0
( set -a; . "$keyfile"; set +a; TF_URL="http://127.0.0.1:$port" node "$repo/src/harness/dist/src/harness/spike/daytona.js" --out "$out" ) \
  2>&1 | tee "$out/spike.log" || status=$?
# Leak check without printing the key: count matches in everything written.
( set -a; . "$keyfile"; set +a; n=$(cat "$out"/*.log "$out"/spike.json 2>/dev/null | grep -cF -- "$DAYTONA_API_KEY" || true); echo "key occurrences in logs and record: ${n:-0}" )
exit "$status"
