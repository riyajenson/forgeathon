# P0 spike findings

Date: 2026-11-18. TrueForge `@truefoundry/trueforge@0.185.1` (local mode, SQLite), SDK `@truefoundry/trueforge-sdk@0.185.0`,
MCP SDK `@modelcontextprotocol/sdk@1.32.2`, zod 4.6.7, Node v24.21.0 (nvm, WSL Ubuntu 26.04).
No real model: `mock-model.mjs` is a scripted OpenAI-compatible server. Raw evidence lives in `logs/` (gitignored).

Legend: **VERIFIED** = observed in this spike. **ASSUMED** = not observed.

## How to reproduce

```bash
. ~/.nvm/nvm.sh && cd spike && npm install
OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","10.255.255.1"]' SQLITE_PATH=$PWD/.data/tf.sqlite npx -y @truefoundry/trueforge@0.185.1 &
node mock-model.mjs &
node mcp-server.mjs &
node setup.mjs
node run.mjs allow   # also: deny cancel cancelrun deferred read err401 errRefused errHole
AGENT=spike-default node run.mjs read default-read
```

## Results

| # | Item | Result |
|---|------|--------|
| 1 | Pinned TrueForge starts with the allowlist | VERIFIED: listens on `localhost:8790`, SQLite at `SQLITE_PATH`, "Auth is disabled". |
| 2 | Our MCP server registers and is reachable | VERIFIED: `settings.mcpServers.createOrUpdate` with header auth. `mcp.initialize` reports `transportType: "streamable-http"`. Every request carried `Host: 127.0.0.1:47615` and the correct bearer token. |
| 3 | `propose_edit` pauses with `tool.approval_required` | VERIFIED: `tool.approval_required {threadId:'main', toolCalls:[{id, sourceEventId}]}` then `turn.update {status:'paused'}`. `sourceEventId` is the `model.message` holding the call. |
| 4 | Allow | VERIFIED: tool executes once, then `tool.response`, final `model.message`, `turn.done(done)`. |
| 5 | Deny with reason reaches the model | VERIFIED: tool NOT executed. The model receives role `tool` content `{"error":[{"type":"text","text":"{\"error\":\"User denied tool call: <reason>\"}"}]}`. |
| 6 | Pause/resume: subscribe(afterEventId) then createTurnEvents | VERIFIED: subscription delivered `user.tool_approval`, `turn.update(running)`, `tool.response`, `model.message`, `turn.done`. No lost events; zero duplicate ids across initial stream + subscription. `afterEventId` = id of the `turn.update(paused)` event. |
| 7 | Cancel while PAUSED | VERIFIED: `sessions.cancel` returned in ~10 ms; subscription got `turn.done {status:'cancelled', reason:'client-cancelled'}`. MCP log shows no `tools/call` and no EXECUTED record for that session. |
| 8 | Cancel while RUNNING (streaming) | VERIFIED: `turn.done(cancelled, client-cancelled)` arrived on the original stream ~24 ms after `cancel()`. TrueForge also sends MCP `notifications/cancelled`. |
| 9 | Deferred tool `call_tool` shape | VERIFIED (schema from the model request + executed call): `{"mcp_server": "vscode", "tool_name": "find_symbol", "input": {"name": "get_debug_flag"}}`. `input` is an object (default `{}`). The call's `toolInfo` is `{type:'truefoundry-system', name:'call_tool'}`; the MCP server receives a normal `tools/call` for `find_symbol`. |
| 10 | Tool names sent to the model | VERIFIED: no prefixing. Sent: `get_current_datetime, call_tool, get_tool_info, get_tool_output_schema, list_tools, propose_edit, read_file`. Deferred `find_symbol` is hidden. Preloaded calls carry `toolInfo {type:'mcp', name, serverId:'vscode', serverName:'vscode'}`. |
| 11 | Annotations read | VERIFIED: `mcpServers.listTools('vscode')` returns our `annotations`. With `requireApprovalForTools` omitted (default `@write,@destructive`): `read_file` (`readOnlyHint:true`) ran without approval; `propose_edit` (`readOnlyHint:false`) required approval. We still list approval tools by name. |
| 12 | Model-name format, custom providers | VERIFIED: `<provider name>/<model name>`, e.g. `mock/m1`. TrueForge sends the configured `modelId` (`mock-1`) upstream. |
| 13 | Upstream call shape | VERIFIED: `POST <baseUrl>/chat/completions`, always `stream: true`, `stream_options: {include_usage: true}`, `tool_choice`, `max_tokens` (= maxOutputTokens). |
| 14 | Error turns | VERIFIED, see table below. Each error turn emits an empty `model.message` before `turn.done(error)`. |
| 15 | SSRF guard | VERIFIED: registering a provider whose host is not allowlisted fails at registration with 400 `Outbound URL blocked for host "10.255.255.1"`. |
| 16 | Sessions in TrueForge UI | VERIFIED (headless browser): all SDK sessions listed under Sessions (title = first user message, agent name, turns, duration). Detail view shows model, tokens, tool-call count, "Agent steps · 1 tool call", and event filters incl. "Approval / HITL". |
| 17 | VS Code extension-host Node version | NOT CHECKED: `~/.vscode-server` does not exist yet; user will report. |

### Error timing (turn start → `turn.done(error)`)

| Scenario | Default env | `MODEL_HTTP_CONNECT_TIMEOUT_MS=3000`, `MODEL_HTTP_MAX_RETRIES=1` |
|---|---|---|
| 401 (wrong key) | 59 ms, 1 upstream request (no retry) | 97 ms |
| Refused port (127.0.0.1:47799) | 125 ms | 218 ms |
| Blackhole (10.255.255.1) | 19.5 s | 7.6 s |

Exact messages:
- 401: `[Model Error] Request failed (401): Incorrect API key provided (mock).` (text after the colon is the provider's `error.message`)
- Refused: `[Model Error] Cannot connect to API: connect ECONNREFUSED 127.0.0.1:47799`
- Blackhole: `[Model Error] Cannot connect to API: Connect Timeout Error (attempted address: 10.255.255.1:80, timeout: 5000ms)` (3000ms with the tuned env)

Classifier proposal: `/\[Model Error\] Request failed \((401|403)\)/` = auth; `/Cannot connect to API/` = network; other `[Model Error]` = model; anything else = harness.

## Implications for the build

- `tools/call` params contain only `name` and `arguments` (no tool-call id, no `_meta`). The MCP server cannot know which approval it belongs to, so keying the review decision by a hash of canonical args (as planned) is required.
- Approval is all-or-nothing per call, so per-hunk results must be stored before sending `allow`, and the tool applies only accepted hunks.
- TrueForge runs `initialize` + `tools/list` per turn and probes `GET /mcp` (we answer 405; it copes). A stateless MCP server works.
- Deferred tools cost extra turns: the injected system prompt says the agent "MUST call list_tools and get_tool_info" before `call_tool`. Keep everything needed for Tasks A/B preloaded; defer only rarely used tools.
- TrueForge adds a `get_current_datetime` system tool.
- For Task C, the blackhole case is ~19.5 s by default. Set `MODEL_HTTP_CONNECT_TIMEOUT_MS=3000 MODEL_HTTP_MAX_RETRIES=1` in the start command (7.6 s), or demo with a refused port / invalid key (< 0.3 s).
- Pass `maxRetries: 0` on `createTurnStream` so the SDK never re-POSTs a turn (used throughout; no problems seen).
- Built-in `openai`/`anthropic` provider manifests have no `name` (one per type); `custom` has a name. A fallback model must come from a different provider type or a `custom` provider.
- Agents have no upsert: `agents.list({agentName})` then `update(id)` or `create` (works; see `setup.mjs`).
