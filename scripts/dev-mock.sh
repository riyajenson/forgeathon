#!/usr/bin/env bash
# Demo without model keys: starts the scripted demo model, a fresh local TrueForge 0.185.1 and the setup.
#
#   scripts/dev-mock.sh                 start in the foreground (Ctrl+C stops everything)
#   scripts/dev-mock.sh --background    start and return (stop with: scripts/dev-mock.sh stop)
#   scripts/dev-mock.sh stop            stop background processes
#   scripts/dev-mock.sh --break-primary re-register the primary model with an invalid key (Task C)
#   scripts/dev-mock.sh --restore       re-register it with the working key
#
# Nothing here is secret: the "keys" are fixed dummy values checked only by the local demo model.
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
state="${FORGE_MOCK_STATE:-$HOME/.forge-mock}"
tf_port="${TRUEFORGE_PORT:-8790}"
model_port=47790
config="$repo/config/models.mock.example.json"
dummy_key="itest-good-key"   # the value the local demo model accepts (see src/harness/testing/mock-model.ts)
export FORGE_MOCK_PRIMARY_KEY="$dummy_key" FORGE_MOCK_FALLBACK_KEY="$dummy_key"
export TRUEFORGE_URL="http://127.0.0.1:$tf_port"

setup() { node "$repo/scripts/setup-trueforge.mjs" --config "$config" --url "$TRUEFORGE_URL"; }

stop_all() {
  for f in "$state"/*.pid; do
    [ -f "$f" ] || continue
    pid="$(cat "$f")"
    kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
    echo "stopped $(basename "$f" .pid) ($pid)"
    rm -f "$f"
  done
}

case "${1:-}" in
  stop) stop_all; exit 0 ;;
  --break-primary) FORGE_MOCK_PRIMARY_KEY="invalid-key-for-task-c" setup; echo "Primary model now has an invalid key. Run Task A to see the fallback; then: scripts/dev-mock.sh --restore"; exit 0 ;;
  --restore) setup; exit 0 ;;
esac

for p in "$tf_port" "$model_port"; do
  if ss -ltn "sport = :$p" | grep -q LISTEN; then echo "port $p is in use; stop the other process first (scripts/dev-mock.sh stop)" >&2; exit 1; fi
done

if [ ! -f "$repo/src/harness/dist/src/harness/index.js" ]; then
  echo "building the harness"; (cd "$repo/src/harness" && npm ci --no-audit --no-fund >/dev/null && npm run build >/dev/null)
fi

mkdir -p "$state"
db="$state/trueforge-$(date +%Y%m%d-%H%M%S).sqlite"
setsid node "$repo/src/harness/dist/src/harness/testing/demo-model-cli.js" --port "$model_port" > "$state/demo-model.log" 2>&1 &
echo $! > "$state/demo-model.pid"
OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1"]' MODEL_HTTP_CONNECT_TIMEOUT_MS=3000 MODEL_HTTP_MAX_RETRIES=1 SQLITE_PATH="$db" \
  setsid npx -y @truefoundry/trueforge@0.185.1 --port "$tf_port" > "$state/trueforge.log" 2>&1 &
echo $! > "$state/trueforge.pid"
[ "${1:-}" = "--background" ] || trap 'echo; stop_all' EXIT INT TERM

# Ready means: the scripted model is listening, TrueForge's health check and its API (not only the UI root)
# answer with 2xx, and they keep answering for three consecutive checks.
ready() {
  ss -ltn "sport = :$model_port" | grep -q LISTEN &&
    curl -sf -o /dev/null --max-time 3 "$TRUEFORGE_URL/healthz" &&
    curl -sf -o /dev/null --max-time 3 "$TRUEFORGE_URL/api/v1/models"
}
echo -n "waiting for TrueForge on $TRUEFORGE_URL"
ok=0
for _ in $(seq 1 180); do
  if ready; then ok=$((ok + 1)); [ "$ok" -ge 3 ] && break; else ok=0; echo -n .; fi
  sleep 0.5
done
echo
[ "$ok" -ge 3 ] || { echo "TrueForge or the scripted model did not become ready; see $state/trueforge.log and $state/demo-model.log" >&2; exit 1; }
setup

cat <<EOF

Demo mode is ready (scripted model, no keys, fresh database $db).
  TrueForge UI:    $TRUEFORGE_URL   (Sessions page shows every turn and tool call)
  Task A / B / C:  launch the extension (F5) on a copy of Flask 3.1.3 and use the fixed instructions
  Task C:          scripts/dev-mock.sh --break-primary   …   scripts/dev-mock.sh --restore
EOF

if [ "${1:-}" = "--background" ]; then echo "running in the background; stop with: scripts/dev-mock.sh stop"; exit 0; fi
echo "Ctrl+C to stop."
wait
