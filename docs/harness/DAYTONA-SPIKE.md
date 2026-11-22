# Daytona spike (branch `harness/p15-daytona`)

Opt-in and off by default: nothing here changes `setup-trueforge.mjs`, the mock, the extension or Tasks A/B/C.
Goal: TrueForge 0.185.1's sandbox provider (Daytona), one skill, and Code Mode, with edits still gated by review.

## Status (2026-11-22, 10:30 IST)

**Blocked on the key.** `scripts/daytona-spike.sh` registered the provider and TrueForge validated it against
Daytona (`validateAccess`: list one snapshot page). Daytona answered `DaytonaAuthenticationError: Invalid
credentials`; a direct `GET https://app.daytona.io/api/snapshots` with the same key also returns **401**. The
value in `.env.daytona` is well formed (no quotes, CR or spaces) but does not have the `dtn_…` shape of a Daytona
API key, so it is probably another token (or for another Daytona endpoint). The key was never printed: the spike
redacts it from every line and record, and counts 0 occurrences in its logs.

Next step: put a Daytona API key (Dashboard → Keys, with sandbox and snapshot permissions) in `.env.daytona` as
`DAYTONA_API_KEY=dtn_…` and rerun `scripts/daytona-spike.sh`. Go/no-go is 15:00 IST.

## What TrueForge 0.185.1 offers (read from the installed source and SDK)

| Feature | Real fields | Notes |
|---|---|---|
| Sandbox provider | `settings.sandboxProviders.createOrUpdate({ manifest: { type: 'daytona', auth: { api_key }, auto_stop_interval_in_minutes, auto_archive_interval_in_minutes, auto_delete_interval_in_minutes, exec_timeout_ms } })` | One provider per tenant; the key is write-only (redacted on read). Validated on save by listing snapshots. API `https://app.daytona.io/api`. |
| Sandbox environment | `sandboxEnvironments.createOrUpdate({ manifest: { name, description?, image?: { type: 'build', build_script? }, networking?: { network_block_all?, domain_allow_list?, secrets? }, resources?, environment_variables? } })` | Daytona needs one for a fresh sandbox. TrueForge's controller (`sandbox-env-build` loop) builds it into a Daytona snapshot; status `pending` → `ready` / `failed`. |
| Agent sandbox | `config.sandbox: { enabled, environment_name?, file_downloads? }` | Adds the `exec` tool (`intent`, `command`, `cwd?`, `env?`); the sandbox persists for the session. Pre-installed: Python 3.13, git, curl, jq, ripgrep. |
| Skills | `settings.skills.createOrUpdate({ manifest: { type: 'git', name, description, url, ref, path? } })`, agent `skills: [{ name, preload? }]` | Mounted into the sandbox (download timeout 180 s) and listed in the agent's instructions. |
| Code Mode | none: on whenever the agent has a sandbox | The agent's MCP tool sets are reachable from code in the sandbox via `mcp_client.call_tool(server, tool, body)` or `mcp-client call-tool …`. Transport: TrueForge connects out to a NATS bridge inside the sandbox through a Daytona preview URL (no inbound port on this machine). The dispatcher refuses tools that need interactive handling (approval) and `create_sub_agent`. |

**Edits stay gated:** `propose_edit` and `run_command` require approval, so Code Mode cannot call them; the
spike checks this. Our `read_file` is callable from Code Mode, which runs in Daytona's cloud, so file content
leaves the machine; for the read-only tools that is the point, and why the spike is opt-in.

## The spike

`scripts/daytona-spike.sh [OUT_DIR]` starts its own TrueForge on :8792 with a fresh database (the key never enters
TrueForge's environment; it is sent once through the settings API), registers the scripted model, the Daytona
provider (auto-stop 5 min, auto-delete 10 min after stop), the `forge-spike` environment, the git skill
`forge-flask-cli` (`skills/forge-flask-cli/SKILL.md` on this branch) and an agent with `config.sandbox` and the
skill, then runs one agent turn through the harness on a scratch workspace. The scripted model calls `exec` four
times:

1. **Sandbox:** `uname`, Python version, `~` contents, no `~/.ssh`.
2. **Skill:** the mounted `forge-flask-cli/SKILL.md`.
3. **Code Mode, read-only:** `mcp-client call-tool forge-spike-vscode read_file '{"path":"src/app.py"}'` returns
   the workspace file through TrueForge and the harness.
4. **Code Mode, write attempt:** `mcp-client call-tool … propose_edit …` must be refused, with no review shown and
   the file unchanged.

Checks (PASS/FAIL) and the redacted step outputs go to `OUT_DIR/spike.json` and `spike.log`.

## If it goes

- Setup: `setup-trueforge.mjs --sandbox daytona` (opt-in) registering the provider from `DAYTONA_API_KEY`, the
  environment and the skill; `forge-coder` gets `config.sandbox` and `skills` only with that flag.
- Code Mode limited to read-only tools: keep `propose_edit`/`run_command` approval-gated (refused from the
  sandbox), and expose only `read_file`, `search_workspace` and `gather_context` to an agent with a sandbox.
- Cost: sandbox minutes while a session runs, then auto-stop after 5 idle minutes and delete 10 minutes later.
- Real runs: Task B with the skill preloaded, paced like the other batches.
