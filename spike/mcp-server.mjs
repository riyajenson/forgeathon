// Stub "vscode" MCP server for the P0 spike: streamable HTTP, stateless, bearer-token protected.
// Logs every request so we can see exactly what TrueForge sends. propose_edit writes nothing.
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const PORT = 47615;
fs.mkdirSync('logs', { recursive: true });
fs.mkdirSync('.data', { recursive: true });
const token = crypto.randomBytes(24).toString('hex');
fs.writeFileSync('.data/mcp-token', token, { mode: 0o600 });
const log = fs.createWriteStream('logs/mcp.jsonl', { flags: 'a' });
const record = (entry) => {
  const line = { ts: new Date().toISOString(), ...entry };
  log.write(JSON.stringify(line) + '\n');
  console.log(JSON.stringify(line));
};

function buildServer() {
  const server = new McpServer({ name: 'vscode', version: '0.0.1' });
  server.registerTool('read_file', {
    description: 'Read a workspace file (spike stub).',
    inputSchema: { path: z.string() },
    annotations: { readOnlyHint: true },
  }, async ({ path }) => ({ content: [{ type: 'text', text: `stub contents of ${path}` }] }));

  server.registerTool('propose_edit', {
    description: 'Propose search/replace edits to a workspace file for user review (spike stub).',
    inputSchema: {
      path: z.string(),
      base_sha256: z.string(),
      edits: z.array(z.object({ old_text: z.string(), new_text: z.string() })),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, async (args) => {
    record({ event: 'EXECUTED', tool: 'propose_edit', args });
    return { content: [{ type: 'text', text: `staged ${args.edits.length} edit(s) for ${args.path}` }] };
  });

  server.registerTool('find_symbol', {
    description: 'Find a symbol definition in the workspace (spike stub).',
    inputSchema: { name: z.string() },
    annotations: { readOnlyHint: true },
  }, async ({ name }) => {
    record({ event: 'EXECUTED', tool: 'find_symbol', args: { name } });
    return { content: [{ type: 'text', text: `${name} defined at src/flask/helpers.py:27` }] };
  });
  return server;
}

const httpServer = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', async () => {
    const authOk = req.headers.authorization === `Bearer ${token}`;
    let body;
    try { body = raw ? JSON.parse(raw) : undefined; } catch { body = undefined; }
    const msgs = Array.isArray(body) ? body : body ? [body] : [];
    record({
      event: 'request', httpMethod: req.method, url: req.url, host: req.headers.host,
      authPresent: Boolean(req.headers.authorization), authOk,
      rpc: msgs.map((m) => ({ method: m.method, id: m.id, params: m.params })),
    });

    if (!authOk) { res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"unauthorized"}'); return; }
    if (req.url !== '/mcp') { res.writeHead(404).end(); return; }
    if (req.method !== 'POST') {
      // Stateless mode: no standalone SSE stream, no session deletion.
      res.writeHead(405, { allow: 'POST' }).end();
      return;
    }
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  });
});

httpServer.listen(PORT, '127.0.0.1', () => console.log(`mcp server on http://127.0.0.1:${PORT}/mcp`));
