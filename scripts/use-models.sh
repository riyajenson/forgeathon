#!/usr/bin/env bash
# Switch the models TrueForge uses, with no code changes: writes config/models.json from
# config/models.example.json with the named profile's primary/fallback pair, then re-runs the setup script
# (providers and agents in TrueForge). The previous config/models.json is kept as config/models.json.bak.
#
# Usage: scripts/use-models.sh [profile] [--break-primary] [--paid-ok] [-- <setup args, e.g. --dry-run --url URL>]
#        scripts/use-models.sh --list
#   nvidia-free      (default) NVIDIA free tier, fallback OpenRouter free tier
#   openrouter-free  OpenRouter free tier, fallback NVIDIA free tier (if NVIDIA throttles on recording day)
#   openrouter-paid  qwen/qwen3-coder-next on OpenRouter: PAID, needs OpenRouter credit and --paid-ok
#   --break-primary  register the primary model with an invalid key (Task C); run again without it to restore
#
# Keys come from the environment (source ~/.forge-keys.env first). They are never written or printed.
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
cfg_dir="${FORGE_CONFIG_DIR:-$repo/config}"

profile="" break_primary=0 paid_ok=0 list=0
setup_args=()
while [ $# -gt 0 ]; do
  case "$1" in
    --list) list=1 ;;
    --break-primary) break_primary=1 ;;
    --paid-ok) paid_ok=1 ;;
    --) shift; setup_args=("$@"); break ;;
    -*) echo "unknown option $1 (see the header of $0)" >&2; exit 64 ;;
    *) [ -z "$profile" ] || { echo "only one profile, got $profile and $1" >&2; exit 64; }; profile="$1" ;;
  esac
  shift
done
dry_run=0
for a in "${setup_args[@]+"${setup_args[@]}"}"; do [ "$a" = "--dry-run" ] && dry_run=1; done

# Writes the config and prints "<primary> <fallback> <primary key variable>" on the last line.
plan="$(LIST="$list" PROFILE="${profile:-nvidia-free}" PAID_OK="$paid_ok" DRY_RUN="$dry_run" CFG_DIR="$cfg_dir" node - <<'EOF'
const fs = require('node:fs');
const path = require('node:path');
const dir = process.env.CFG_DIR;
const example = JSON.parse(fs.readFileSync(path.join(dir, 'models.example.json'), 'utf8'));
const profiles = example.profiles ?? {};
const fail = (msg, code = 2) => { console.error(msg); process.exit(code); };
if (process.env.LIST === '1') {
  for (const [name, p] of Object.entries(profiles)) console.error(`${name.padEnd(16)} ${p.primaryModel} → fallback ${p.fallbackModel}${p.paid ? '  [PAID]' : ''}\n${' '.repeat(17)}${p.note ?? ''}`);
  process.exit(3);
}
const name = process.env.PROFILE;
const profile = profiles[name];
if (!profile) fail(`unknown profile "${name}"; profiles: ${Object.keys(profiles).join(', ')}`);
if (profile.paid && process.env.PAID_OK !== '1') {
  fail(`profile ${name} uses a PAID model (${profile.primaryModel}) and needs OpenRouter credit. Add --paid-ok to use it. config/models.json was not changed.`);
}
const provider = (fqn) => example.providers.find((p) => (p.name ?? p.type) === fqn.split('/')[0]);
const keyVar = (fqn) => provider(fqn)?.apiKeyEnv ?? '';
if (process.env.DRY_RUN !== '1') {
  const missing = [profile.primaryModel, profile.fallbackModel].map(keyVar).filter((v) => v && !process.env[v]);
  if (missing.length) fail(`${missing.join(' and ')} not set: source ~/.forge-keys.env first. config/models.json was not changed.`);
}
const out = { ...example, agents: { primaryModel: profile.primaryModel, fallbackModel: profile.fallbackModel } };
const target = path.join(dir, 'models.json');
const text = JSON.stringify(out, null, 2) + '\n';
if (fs.existsSync(target)) {
  const old = fs.readFileSync(target, 'utf8');
  if (old !== text) fs.writeFileSync(`${target}.bak`, old);
}
fs.writeFileSync(target, text);
console.error(`profile ${name}: primary ${profile.primaryModel}, fallback ${profile.fallbackModel}${profile.paid ? ' (PAID)' : ''}`);
console.log(`${profile.primaryModel} ${profile.fallbackModel} ${keyVar(profile.primaryModel)}`);
EOF
)" || { code=$?; [ "$code" = 3 ] && exit 0; exit "$code"; }
read -r primary fallback primary_key <<<"$plan"

env_override=()
if [ "$break_primary" = 1 ]; then
  [ -n "$primary_key" ] || { echo "the primary provider has no apiKeyEnv; cannot break it" >&2; exit 2; }
  env_override=("$primary_key=invalid-key-for-task-c")
  restore="$0 ${profile:-nvidia-free}"; [ "$paid_ok" = 1 ] && restore="$restore --paid-ok"
  echo "Task C: the primary model ($primary) is registered with an invalid key; restore with: $restore"
fi
env "${env_override[@]+"${env_override[@]}"}" node "$repo/scripts/setup-trueforge.mjs" --config "$cfg_dir/models.json" "${setup_args[@]+"${setup_args[@]}"}"
