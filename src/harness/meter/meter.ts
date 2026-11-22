// Model request meter: a loopback pass-through proxy between TrueForge and OpenAI-compatible providers.
// It sees every upstream request, including the ones TrueForge retries internally (e.g. after a 429),
// which the harness cannot observe. One record per request: route, model id, HTTP status, duration,
// Retry-After and token usage. Request and response bodies, headers and keys are never recorded.
import { promises as fs } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';

export interface MeterRecord {
  ts: string;
  route: string;
  path: string;
  model?: string;
  /** Upstream HTTP status; 0 when the upstream could not be reached. */
  status: number;
  ms: number;
  retryAfter?: string;
  inputTokens?: number;
  outputTokens?: number;
  error?: string;
  /** Time the request waited in the meter to keep the route's pace (--min-interval-ms). */
  queuedMs?: number;
  /** Names of the tools offered to the model in this request (only with --log-tools). */
  tools?: string[];
}

export interface MeterSummary {
  requests: number;
  ok: number;
  status429: number;
  otherErrors: number;
  inputTokens: number;
  outputTokens: number;
}

export interface Meter {
  port: number;
  close(): Promise<void>;
}

/** Token usage from a JSON body or from the last SSE chunk that carries one (OpenAI-compatible shapes). */
export function usageOf(text: string): { inputTokens: number; outputTokens: number } | undefined {
  const pick = (u: unknown) => {
    const x = u as { prompt_tokens?: unknown; completion_tokens?: unknown } | undefined;
    return x && typeof x.prompt_tokens === 'number' ? { inputTokens: x.prompt_tokens, outputTokens: typeof x.completion_tokens === 'number' ? x.completion_tokens : 0 } : undefined;
  };
  try {
    return pick((JSON.parse(text) as { usage?: unknown }).usage);
  } catch { /* not a single JSON document: SSE */ }
  let found: ReturnType<typeof pick>;
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    try { found = pick((JSON.parse(line.slice(5)) as { usage?: unknown }).usage) ?? found; } catch { /* [DONE] or a cut-off chunk */ }
  }
  return found;
}

/** Totals per "<route> <model>". */
export function summarise(records: MeterRecord[]): Record<string, MeterSummary> {
  const by: Record<string, MeterSummary> = {};
  for (const r of records) {
    const s = (by[`${r.route} ${r.model ?? '?'}`] ??= { requests: 0, ok: 0, status429: 0, otherErrors: 0, inputTokens: 0, outputTokens: 0 });
    s.requests++;
    if (r.status >= 200 && r.status < 300) s.ok++;
    else if (r.status === 429) s.status429++;
    else s.otherErrors++;
    s.inputTokens += r.inputTokens ?? 0;
    s.outputTokens += r.outputTokens ?? 0;
  }
  return by;
}

export interface RequestStats {
  total: number;
  status429: number;
  otherErrors: number;
  /** Requests per "<route> <model>". */
  byModel: Record<string, number>;
}

export function requestStats(records: MeterRecord[]): RequestStats {
  const byModel = Object.fromEntries(Object.entries(summarise(records)).map(([k, v]) => [k, v.requests]));
  const bad = (r: MeterRecord) => r.status !== 429 && (r.status < 200 || r.status >= 300);
  return { total: records.length, status429: records.filter((r) => r.status === 429).length, otherErrors: records.filter(bad).length, byModel };
}

/** Records appended to a meter log after its first `from` lines; a missing file has none. */
export async function meterRecordsSince(file: string | undefined, from: number): Promise<{ lines: number; records: MeterRecord[] }> {
  if (!file) return { lines: 0, records: [] };
  const lines = (await fs.readFile(file, 'utf8').catch(() => '')).split('\n').filter(Boolean);
  return { lines: lines.length, records: lines.slice(from).map((l) => JSON.parse(l) as MeterRecord) };
}

/** Keeps the last `max` characters of a stream: enough for the final SSE usage chunk. */
const TAIL_CHARS = 16_384;

/**
 * minIntervalMs: upstream requests on one route start at least this far apart (e.g. 1600 ms keeps a provider under
 * 40 requests/min, NVIDIA's free tier). Requests wait in the meter; TrueForge only sees a slower response.
 */
export async function startMeter(o: { port?: number; routes: Record<string, string>; minIntervalMs?: number; logTools?: boolean; onRecord(r: MeterRecord): void }): Promise<Meter> {
  const routes = new Map(Object.entries(o.routes).map(([k, v]) => [k, new URL(v.replace(/\/+$/, ''))]));
  const nextSlot = new Map<string, number>();
  const paced = (route: string): Promise<number> => {
    const gap = o.minIntervalMs ?? 0;
    if (gap <= 0) return Promise.resolve(0);
    const now = Date.now();
    const at = Math.max(now, nextSlot.get(route) ?? 0);
    nextSlot.set(route, at + gap);
    return new Promise((resolve) => setTimeout(() => resolve(at - now), at - now));
  };
  const server = http.createServer((req, res) => {
    const [, routeName = '', ...rest] = (req.url ?? '/').split('/');
    const upstream = routes.get(routeName);
    if (!upstream) { res.writeHead(404).end('unknown route'); return; }
    const target = new URL(`${upstream.pathname}/${rest.join('/')}`, upstream);
    let started = Date.now();
    let base: { ts: string; route: string; path: string; queuedMs?: number; tools?: string[] } = { ts: '', route: routeName, path: `/${rest.join('/')}` };
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      const queuedMs = await paced(routeName);
      started = Date.now();
      base = { ts: new Date(started).toISOString(), route: routeName, path: base.path, ...(queuedMs ? { queuedMs } : {}) };
      const body = Buffer.concat(chunks);
      let model: string | undefined;
      let tools: string[] | undefined;
      try {
        const parsed = JSON.parse(body.toString('utf8')) as { model?: unknown; tools?: Array<{ function?: { name?: unknown } }> };
        if (typeof parsed.model === 'string') model = parsed.model;
        if (o.logTools && Array.isArray(parsed.tools)) tools = parsed.tools.map((t) => String(t?.function?.name ?? '?'));
      } catch { /* not JSON */ }
      if (tools) base = { ...base, tools };
      const headers: http.OutgoingHttpHeaders = { ...req.headers, host: target.host, 'content-length': String(body.length) };
      delete headers['accept-encoding']; // plain responses so usage can be read; bodies are never stored
      const send = target.protocol === 'https:' ? https.request : http.request;
      const up = send(target, { method: req.method ?? 'POST', headers }, (ur) => {
        res.writeHead(ur.statusCode ?? 502, ur.headers);
        let tail = '';
        ur.on('data', (c: Buffer) => { res.write(c); tail = (tail + c.toString('utf8')).slice(-TAIL_CHARS); });
        ur.on('end', () => {
          res.end();
          const retryAfter = ur.headers['retry-after'];
          o.onRecord({ ...base, ...(model ? { model } : {}), status: ur.statusCode ?? 0, ms: Date.now() - started, ...(retryAfter ? { retryAfter: String(retryAfter) } : {}), ...(usageOf(tail) ?? {}) });
        });
      });
      up.on('error', (e: NodeJS.ErrnoException) => {
        o.onRecord({ ...base, ...(model ? { model } : {}), status: 0, ms: Date.now() - started, error: e.code ?? 'error' });
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      res.on('close', () => { if (!res.writableEnded) up.destroy(); }); // the client went away mid-response
      up.end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(o.port ?? 0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
