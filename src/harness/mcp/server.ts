// Streamable-HTTP MCP server for the editor tools. Binds 127.0.0.1 only, requires a bearer token,
// and checks the Host header against DNS rebinding. Stateless: one McpServer per request.
import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { proposeEditTool, readFileTool, searchWorkspaceTool, type ToolContext, type ToolOutcome } from './tools';

export const MCP_PATH = '/mcp';
const MAX_BODY_BYTES = 4 * 1024 * 1024;

export interface McpServerOptions {
  context: ToolContext;
  /** 0 picks a free port (tests). */
  port: number;
  /** Generated when omitted. */
  token?: string;
}

export interface RunningMcpServer {
  url: string;
  port: number;
  token: string;
  close(): Promise<void>;
}

function toResult(outcome: ToolOutcome): CallToolResult {
  if (outcome.ok) return { content: [{ type: 'text', text: outcome.text }] };
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: { code: outcome.code, message: outcome.message } }) }] };
}

export function buildMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: 'vscode', version: '0.1.0' });

  server.registerTool('read_file', {
    description:
      'Read a workspace file (current editor buffer if unsaved). Returns its sha256, needed by propose_edit, and ' +
      'numbered lines as "<n>\\t<text>". Read only the line range you need. Never copy the line-number prefix into edits.',
    inputSchema: {
      path: z.string().describe('Workspace-relative path, e.g. src/flask/cli.py'),
      start_line: z.number().int().min(1).optional().describe('First line to show (1-based)'),
      end_line: z.number().int().min(1).optional().describe('Last line to show (inclusive)'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (args) => toResult(await readFileTool(ctx, args)));

  server.registerTool('search_workspace', {
    description:
      'Search workspace text files line by line (ignores .git, node_modules and .gitignore). ' +
      'Returns "path:line: text" matches. Plain text by default; set regex=true for a JavaScript regular expression.',
    inputSchema: {
      query: z.string().min(1),
      regex: z.boolean().optional(),
      case_sensitive: z.boolean().optional(),
      path_prefix: z.string().optional().describe('Only search under this workspace-relative directory'),
      max_results: z.number().int().min(1).max(200).optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (args) => toResult(await searchWorkspaceTool(ctx, args)));

  server.registerTool('propose_edit', {
    description:
      'Propose changes to ONE file for the user to review hunk by hunk in the editor. Each edit replaces old_text, ' +
      'which must match the current file exactly once (copy it verbatim, with enough surrounding lines to be unique), ' +
      'with new_text. Edits must not overlap. base_sha256 is the sha256 from read_file ("" to create a new file, with ' +
      'one edit whose old_text is ""). Only hunks the user accepts are written; the result says which.',
    inputSchema: {
      path: z.string(),
      base_sha256: z.string(),
      edits: z.array(z.object({ old_text: z.string(), new_text: z.string() })).min(1),
      summary: z.string().optional().describe('One line describing the change, shown to the reviewer'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (args) => toResult(await proposeEditTool(ctx, args)));

  return server;
}

function tokenMatches(header: string | undefined, token: string): boolean {
  const expected = Buffer.from(`Bearer ${token}`);
  const got = Buffer.from(header ?? '');
  return got.length === expected.length && timingSafeEqual(got, expected);
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try { resolve(raw ? JSON.parse(raw) : undefined); } catch { resolve(undefined); }
    });
    req.on('error', reject);
  });
}

export async function startMcpServer(options: McpServerOptions): Promise<RunningMcpServer> {
  const token = options.token ?? randomBytes(32).toString('hex');
  const { context } = options;
  let allowedHosts: Set<string> = new Set();

  const httpServer = http.createServer(async (req, res) => {
    try {
      if (!allowedHosts.has(req.headers.host ?? '')) {
        res.writeHead(403, { 'content-type': 'application/json' }).end('{"error":"forbidden host"}');
        return;
      }
      if (!tokenMatches(req.headers.authorization, token)) {
        res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"unauthorized"}');
        return;
      }
      if ((req.url ?? '').split('?')[0] !== MCP_PATH) { res.writeHead(404).end(); return; }
      if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }).end(); return; }

      const body = await readBody(req);
      const server = buildMcpServer(context);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => { void transport.close(); void server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      context.port.log('error', `mcp request failed: ${(e as Error).message}`);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' }).end('{"error":"internal"}');
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(options.port, '127.0.0.1', () => { httpServer.off('error', reject); resolve(); });
  });
  const port = (httpServer.address() as AddressInfo).port;
  allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  context.port.log('info', `MCP server listening on http://127.0.0.1:${port}${MCP_PATH}`);

  return {
    url: `http://127.0.0.1:${port}${MCP_PATH}`,
    port,
    token,
    close: () => new Promise<void>((resolve) => {
      httpServer.closeAllConnections();
      httpServer.close(() => resolve());
    }),
  };
}
