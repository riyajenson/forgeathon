// Scripted OpenAI-compatible chat-completions server for integration tests. No real model involved.
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export type MockReply =
  | { text: string; delayMsPerWord?: number }
  | { toolCalls: Array<{ name: string; args: unknown }> }
  | { status: number; message: string };

export interface MockRequest {
  model: string;
  authOk: boolean;
  stream: boolean;
  parallelToolCalls: unknown;
  messages: Array<{ role: string; content?: unknown; tool_call_id?: string }>;
  toolNames: string[];
}

export const MOCK_KEY = 'itest-good-key';

export function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => (p && typeof p === 'object' && 'text' in p ? String((p as { text: unknown }).text) : '')).join('');
  return '';
}

/** First "SCENARIO:<name>" marker in the user messages. */
export function scenarioOf(req: MockRequest): string {
  for (const m of req.messages) {
    if (m.role !== 'user') continue;
    const hit = /SCENARIO:([a-z0-9-]+)/.exec(textOf(m.content));
    if (hit) return hit[1]!;
  }
  return 'plain';
}

export class MockModel {
  readonly requests: MockRequest[] = [];
  handler: (req: MockRequest) => MockReply = () => ({ text: 'ok' });
  private server: http.Server | undefined;
  port = 0;

  async start(port = 0): Promise<void> {
    this.server = http.createServer((rq, rs) => {
      let raw = '';
      rq.on('data', (c) => (raw += c));
      rq.on('end', () => void this.handle(rq, rs, raw));
    });
    await new Promise<void>((resolve) => this.server!.listen(port, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }

  private async handle(rq: http.IncomingMessage, rs: http.ServerResponse, raw: string): Promise<void> {
    const body = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>;
    if (rq.method === 'GET') {
      rs.writeHead(200, { 'content-type': 'application/json' }).end('{"object":"list","data":[]}');
      return;
    }
    const req: MockRequest = {
      model: String(body['model'] ?? ''),
      authOk: rq.headers.authorization === `Bearer ${MOCK_KEY}`,
      stream: body['stream'] === true,
      parallelToolCalls: body['parallel_tool_calls'],
      messages: (body['messages'] as MockRequest['messages']) ?? [],
      toolNames: ((body['tools'] as Array<{ function?: { name?: string } }>) ?? []).map((t) => t.function?.name ?? ''),
    };
    this.requests.push(req);
    if (!req.authOk) {
      rs.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'Incorrect API key provided (mock).', type: 'invalid_request_error' } }));
      return;
    }
    const reply = this.handler(req);
    if ('status' in reply) {
      rs.writeHead(reply.status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: reply.message } }));
      return;
    }
    const id = `chatcmpl-${Date.now()}`;
    const chunk = (delta: unknown, finish: string | null = null) =>
      `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: req.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    rs.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    rs.write(chunk({ role: 'assistant', content: '' }));
    let finish = 'stop';
    if ('toolCalls' in reply) {
      finish = 'tool_calls';
      reply.toolCalls.forEach((c, i) => {
        rs.write(chunk({ tool_calls: [{ index: i, id: `call_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 8)}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } }] }));
      });
    } else {
      for (const word of reply.text.split(' ')) {
        if (rs.destroyed) return;
        rs.write(chunk({ content: `${word} ` }));
        if (reply.delayMsPerWord) await new Promise((r) => setTimeout(r, reply.delayMsPerWord));
      }
    }
    rs.write(chunk({}, finish));
    rs.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: req.model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
    rs.end('data: [DONE]\n\n');
  }
}
