// Scripted OpenAI-compatible model for the P0 spike. No real model or API key involved.
// The scenario is picked by a "SCENARIO:<name>" marker in the first user message.
import http from 'node:http';
import fs from 'node:fs';

const PORT = 47700;
const GOOD_KEY = 'spike-good-key';
fs.mkdirSync('logs', { recursive: true });
const reqLog = fs.createWriteStream('logs/model-requests.jsonl', { flags: 'a' });

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => p.text ?? '').join('');
  return '';
}

function scenarioOf(messages) {
  for (const m of messages) {
    if (m.role !== 'user') continue;
    const hit = /SCENARIO:([a-z0-9-]+)/.exec(textOf(m.content));
    if (hit) return hit[1];
  }
  return 'plain';
}

function findTool(tools, needle) {
  return (tools ?? []).map((t) => t.function).find((f) => f && f.name.includes(needle));
}

// Fill a meta tool (e.g. call_tool) from its JSON schema without knowing the exact shape up front.
function fillMetaArgs(schema, server, tool, toolArgs) {
  const out = {};
  for (const [key, prop] of Object.entries(schema?.properties ?? {})) {
    const k = key.toLowerCase();
    if (k.includes('server')) out[key] = server;
    else if (k.includes('tool') && (prop.type === 'string' || !prop.type)) out[key] = tool;
    else if (prop.type === 'object' || k.includes('arg') || k.includes('input') || k.includes('param')) {
      out[key] = prop.type === 'string' ? JSON.stringify(toolArgs) : toolArgs;
    }
  }
  return out;
}

// Decide the next assistant turn: either { toolCall: {name, args} } or { text }.
function decide(body) {
  const messages = body.messages ?? [];
  const scenario = scenarioOf(messages);
  const last = messages[messages.length - 1];
  const toolMsgs = messages.filter((m) => m.role === 'tool');

  if (last?.role === 'tool') {
    return { text: `ACK tool result: ${textOf(last.content).slice(0, 500)}` };
  }
  if (scenario === 'propose' && toolMsgs.length === 0) {
    const t = findTool(body.tools, 'propose_edit');
    if (!t) return { text: 'NO propose_edit TOOL VISIBLE' };
    return {
      toolCall: {
        name: t.name,
        args: { path: 'src/flask/helpers.py', base_sha256: 'abc123', edits: [{ old_text: 'x = 1', new_text: 'x = 2' }] },
      },
    };
  }
  if (scenario === 'read' && toolMsgs.length === 0) {
    const t = findTool(body.tools, 'read_file');
    if (!t) return { text: 'NO read_file TOOL VISIBLE' };
    return { toolCall: { name: t.name, args: { path: 'src/flask/helpers.py' } } };
  }
  if (scenario === 'deferred' && toolMsgs.length === 0) {
    const direct = findTool(body.tools, 'find_symbol');
    if (direct) return { toolCall: { name: direct.name, args: { name: 'get_debug_flag' } } };
    const meta = findTool(body.tools, 'call_tool');
    if (!meta) return { text: 'NO call_tool META TOOL VISIBLE' };
    return { toolCall: { name: meta.name, args: fillMetaArgs(meta.parameters, 'vscode', 'find_symbol', { name: 'get_debug_flag' }) } };
  }
  if (scenario === 'slow') return { text: 'slow '.repeat(40), slowMs: 500 };
  return { text: `plain reply for scenario ${scenario}` };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function respond(res, body, decision) {
  const id = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const model = body.model;
  const usage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 };
  const toolCalls = decision.toolCall
    ? [{ id: `call_${Date.now()}`, type: 'function', function: { name: decision.toolCall.name, arguments: JSON.stringify(decision.toolCall.args) } }]
    : undefined;
  const finish = toolCalls ? 'tool_calls' : 'stop';

  if (!body.stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id, object: 'chat.completion', created, model,
      choices: [{ index: 0, finish_reason: finish, message: { role: 'assistant', content: decision.text ?? null, tool_calls: toolCalls } }],
      usage,
    }));
    return;
  }

  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const send = (delta, finish_reason = null, extra = {}) =>
    res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason }], ...extra })}\n\n`);
  send({ role: 'assistant', content: '' });
  if (toolCalls) {
    send({ tool_calls: [{ index: 0, ...toolCalls[0] }] });
  } else {
    const words = decision.text.split(' ');
    for (const w of words) {
      if (res.destroyed) return;
      send({ content: `${w} ` });
      if (decision.slowMs) await sleep(decision.slowMs);
    }
  }
  send({}, finish);
  if (body.stream_options?.include_usage) res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [], usage })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', async () => {
    const auth = req.headers.authorization ?? '';
    const authOk = auth === `Bearer ${GOOD_KEY}`;
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { /* keep empty */ }
    reqLog.write(JSON.stringify({ ts: new Date().toISOString(), method: req.method, url: req.url, authOk, body }) + '\n');
    console.log(`${new Date().toISOString()} ${req.method} ${req.url} auth=${authOk} stream=${body.stream} scenario=${scenarioOf(body.messages ?? [])}`);

    if (!authOk) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Incorrect API key provided (mock).', type: 'invalid_request_error', code: 'invalid_api_key' } }));
      return;
    }
    if (req.method === 'GET' && req.url.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-1', object: 'model', owned_by: 'spike' }] }));
      return;
    }
    if (req.method === 'POST' && req.url.endsWith('/chat/completions')) {
      await respond(res, body, decide(body));
      return;
    }
    res.writeHead(404).end();
  });
});

server.listen(PORT, '127.0.0.1', () => console.log(`mock model on http://127.0.0.1:${PORT}/v1`));
