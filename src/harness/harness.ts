// ForgeHarness implementation: local application sessions/turns mapped onto TrueForge sessions,
// plus the editor MCP server that TrueForge calls back into.
import { randomUUID } from 'node:crypto';
import {
  PROTOCOL_VERSION, type CancelStatus, type EditorBridge, type ForgeHarness, type HarnessEvent, type ProtocolError,
  type Request, type Response, type ReviewDecision, type SessionId, type SessionStatus, type TurnRef, type TurnRequest,
} from './contract-types';
import { ScopeRegistry } from './mcp/scope';
import { canonicalJson } from './review/canonical';
import { startMcpServer, type RunningMcpServer } from './mcp/server';
import { isTrueForgeUnreachable, safeMessage } from './trueforge/errors';
import { createClient, type TrueForgeClient, type TrueForgeSdk } from './trueforge/sdk';
import { TurnRun } from './turn/turn';
import { defaultTurnLogPath } from './turn/turn-log';

export interface HarnessOptions {
  /** TrueForge base URL. Default http://127.0.0.1:8790. */
  trueforgeUrl?: string;
  /** Loopback port for the editor MCP server. Default 47615. */
  mcpPort?: number;
  /** TrueForge agent names. Defaults forge-inline / forge-coder; fallbacks are `${name}-fallback`. */
  agents?: { inline?: string; agent?: string };
  /** How long cancel waits for TrueForge to confirm. Default 5000 ms. */
  cancelTimeoutMs?: number;
  /** No TrueForge events for this long while running → cancel and treat as model unavailable. Default 45000 ms. */
  watchdogMs?: number;
  /** How long a finished attempt waits for its tool calls to settle before deciding on retry/fallback. Default 10000 ms. */
  settleMs?: number;
  /** Delay before the single retry of an unavailable model. Default 2000 ms. */
  retryDelayMs?: number;
  /** Token budget for automatically assembled context in agent mode (setting forge.context.budgetTokens). Default 8000. */
  contextBudgetTokens?: number;
  /** Name of the MCP connector registered in TrueForge. Default "vscode". */
  connectorName?: string;
  /** JSON-lines log of every turn (models, attempts, tokens, timing; no content). Default ~/.forge/turns.jsonl
   *  or FORGE_TURN_LOG; false disables it. */
  turnLogPath?: string | false;
}

/** Connector name the agent definitions reference. */
export const DEFAULT_CONNECTOR = 'vscode';

interface AppSession {
  id: SessionId;
  workspaceRoot: string;
  state: 'open' | 'closed';
  runtime: Map<string, string>;
  turns: Map<string, TurnRun>;
  active: TurnRun | undefined;
}

const err = (code: ProtocolError['code'], message: string, retryable = false, workspaceEffect: ProtocolError['workspaceEffect'] = 'unchanged'): ProtocolError =>
  ({ code, message, retryable, workspaceEffect });

function reply<T>(req: { requestId?: unknown }, body: T): Response<T> {
  return { version: PROTOCOL_VERSION, requestId: String(req.requestId ?? ''), ok: true, body };
}

function refuse<T>(req: { requestId?: unknown }, error: ProtocolError): Response<T> {
  return { version: PROTOCOL_VERSION, requestId: String(req.requestId ?? ''), ok: false, error };
}

function versionError(req: Request<unknown>): ProtocolError | undefined {
  if (!req || typeof req !== 'object') return err('invalid', 'request must be an object');
  if (req.version !== PROTOCOL_VERSION) return err('version', `protocol ${String(req.version)} is not supported; expected ${PROTOCOL_VERSION}`);
  if (typeof req.requestId !== 'string' || !req.requestId) return err('invalid', 'requestId must be a non-empty string');
  return undefined;
}

class ForgeHarnessImpl implements ForgeHarness {
  private readonly url: string;
  private readonly scopes = new ScopeRegistry();
  private readonly sessions = new Map<SessionId, AppSession>();
  private readonly submitted = new Map<string, { fingerprint: string; response: Response<TurnRef> }>();
  private port: EditorBridge | undefined;
  private sdk: TrueForgeSdk | undefined;
  private client: TrueForgeClient | undefined;
  private mcp: RunningMcpServer | undefined;

  constructor(private readonly options: HarnessOptions) {
    this.url = (options.trueforgeUrl ?? 'http://127.0.0.1:8790').replace(/\/+$/, '');
  }

  async start(bridge: EditorBridge): Promise<void> {
    if (this.mcp) throw new Error('forge-harness is already started');
    this.port = bridge;
    const { sdk, client } = await createClient(this.url);
    try {
      await client.models.list();
    } catch (e) {
      throw new Error(isTrueForgeUnreachable(e)
        ? `TrueForge is not reachable at ${this.url}. Start it first (see README).`
        : `TrueForge at ${this.url} did not answer correctly: ${safeMessage((e as Error).message)}`);
    }
    const listenPort = this.options.mcpPort ?? 47615;
    try {
      this.mcp = await startMcpServer({ port: bridge, scopes: this.scopes, listenPort });
    } catch (e) {
      if ((e as { code?: string }).code !== 'EADDRINUSE') throw e;
      throw new Error(`The editor-tools port 127.0.0.1:${listenPort} is in use (another VS Code window with Forge, or another program). Close it, or set "forge.mcpPort" to a free port.`);
    }
    try {
      await client.settings.mcpServers.createOrUpdate({
        manifest: {
          type: 'remote',
          name: this.options.connectorName ?? DEFAULT_CONNECTOR,
          url: this.mcp.url,
          description: 'VS Code editor tools: read, search, context and review-gated edits',
          auth: { type: 'header', headers: { Authorization: `Bearer ${this.mcp.token}` } },
        },
      });
    } catch (e) {
      await this.mcp.close();
      this.mcp = undefined;
      const blocked = /Outbound URL blocked/i.test(String((e as Error).message) + JSON.stringify((e as { body?: unknown }).body ?? ''));
      throw new Error(blocked
        ? 'TrueForge refused the loopback MCP URL. Start TrueForge with OUTBOUND_URL_ALLOWED_HOSTS=\'["127.0.0.1"]\'.'
        : `Could not register the editor tools with TrueForge: ${safeMessage((e as Error).message)}`);
    }
    this.sdk = sdk;
    this.client = client;
    bridge.log('info', `forge-harness ready: TrueForge ${this.url}, MCP ${this.mcp.url}`);
  }

  async createSession(req: Request<{ workspaceRoot: string }>): Promise<Response<SessionStatus>> {
    const bad = versionError(req);
    if (bad) return refuse(req, bad);
    if (typeof req.body?.workspaceRoot !== 'string' || !req.body.workspaceRoot.startsWith('/')) {
      return refuse(req, err('invalid', 'workspaceRoot must be an absolute POSIX path'));
    }
    const id = randomUUID();
    this.sessions.set(id, { id, workspaceRoot: req.body.workspaceRoot, state: 'open', runtime: new Map(), turns: new Map(), active: undefined });
    return reply(req, { sessionId: id, state: 'open', activeTurnId: null });
  }

  async submitTurn(req: Request<TurnRequest>): Promise<Response<TurnRef>> {
    const bad = versionError(req);
    if (bad) return refuse(req, bad);
    // Same contents, any property order (contracts/README.md: identity is defined by contents).
    const fingerprint = canonicalJson(req.body);
    const prior = this.submitted.get(req.requestId);
    if (prior) return prior.fingerprint === fingerprint ? prior.response : refuse(req, err('conflict', 'requestId was already used for a different turn'));

    const b = req.body;
    if (!this.client || !this.sdk || !this.port) return refuse(req, err('unavailable', 'forge-harness is not started', true));
    if (!b || typeof b.turnId !== 'string' || !b.turnId || typeof b.instruction !== 'string' || !b.instruction.trim()) {
      return refuse(req, err('invalid', 'turnId and a non-empty instruction are required'));
    }
    if (b.mode !== 'inline' && b.mode !== 'agent') return refuse(req, err('invalid', 'mode must be inline or agent'));
    if (b.commandBudget !== undefined && !(Number.isInteger(b.commandBudget) && b.commandBudget >= 0)) {
      return refuse(req, err('invalid', 'commandBudget must be a non-negative integer'));
    }
    if (b.testCommandBudget !== undefined && !(Number.isInteger(b.testCommandBudget) && b.testCommandBudget >= 0)) {
      return refuse(req, err('invalid', 'testCommandBudget must be a non-negative integer'));
    }
    if (b.resumeOf !== undefined && (typeof b.resumeOf !== 'string' || !b.resumeOf)) return refuse(req, err('invalid', 'resumeOf must be a turn id'));
    const session = this.sessions.get(b.sessionId);
    if (!session || session.state !== 'open') return refuse(req, err('invalid', 'unknown or closed session'));
    if (session.turns.has(b.turnId)) return refuse(req, err('conflict', 'turnId already exists in this session'));
    if (session.active && !session.active.done) return refuse(req, err('conflict', 'another turn is still running in this session', true));
    let resumeFrom: ReturnType<() => TurnRun['resumable']>;
    if (b.resumeOf !== undefined) {
      const prior = session.turns.get(b.resumeOf);
      if (!prior) return refuse(req, err('invalid', 'resumeOf names no turn of this session'));
      if (prior.req.mode !== b.mode) return refuse(req, err('invalid', 'a resumed turn must use the mode of the turn it resumes'));
      resumeFrom = prior.resumable;
      if (!resumeFrom) return refuse(req, err('conflict', 'that turn cannot be resumed: it did not stop on a rate limit, or it was already resumed'));
      prior.markResumed(b.turnId);
    }

    const agentName = b.mode === 'inline' ? (this.options.agents?.inline ?? 'forge-inline') : (this.options.agents?.agent ?? 'forge-coder');
    const client = this.client;
    const run = new TurnRun(b, {
      sdk: this.sdk,
      client,
      port: this.port,
      scopes: this.scopes,
      trueforgeUrl: this.url,
      workspaceRoot: session.workspaceRoot,
      agentName,
      runtimeSession: async (agent, fresh) => {
        const existing = session.runtime.get(agent);
        if (existing && !fresh) return existing;
        const { data } = await client.sessions.create({ agent: { name: agent }, metadata: { source: 'forge-vscode', appSession: session.id } }, { maxRetries: 0, timeoutInSeconds: 30 });
        session.runtime.set(agent, data.id);
        return data.id;
      },
      agentModel: (agent) => this.modelOf(agent),
      cancelTimeoutMs: this.options.cancelTimeoutMs ?? 5000,
      watchdogMs: this.options.watchdogMs ?? 45000,
      contextBudgetTokens: this.options.contextBudgetTokens ?? 8000,
      retryDelayMs: this.options.retryDelayMs ?? 2000,
      settleMs: this.options.settleMs ?? 10000,
      turnLogPath: this.options.turnLogPath === undefined ? defaultTurnLogPath() : this.options.turnLogPath || undefined,
      resumeFrom,
    });
    session.turns.set(b.turnId, run);
    session.active = run;
    void run.start();
    const response = reply(req, { sessionId: b.sessionId, turnId: b.turnId });
    this.submitted.set(req.requestId, { fingerprint, response });
    return response;
  }

  async *stream(req: Request<TurnRef & { afterSequence: number }>): AsyncIterable<Response<HarnessEvent>> {
    const bad = versionError(req);
    if (bad) return yield refuse(req, bad);
    const run = this.sessions.get(req.body?.sessionId)?.turns.get(req.body?.turnId);
    if (!run) return yield refuse(req, err('invalid', 'unknown turn'));
    const after = Number.isInteger(req.body.afterSequence) && req.body.afterSequence >= 0 ? req.body.afterSequence : 0;
    for await (const event of run.buffer.read(after)) yield reply(req, event);
  }

  async submitReview(req: Request<ReviewDecision>): Promise<Response<null>> {
    const bad = versionError(req);
    if (bad) return refuse(req, bad);
    const run = this.sessions.get(req.body?.sessionId)?.turns.get(req.body?.turnId);
    if (!run) return refuse(req, err('invalid', 'unknown turn'));
    const result = run.submitReview(req.body);
    return result.ok ? reply(req, null) : refuse(req, result.error);
  }

  async cancel(req: Request<TurnRef>): Promise<Response<CancelStatus>> {
    const bad = versionError(req);
    if (bad) return refuse(req, bad);
    const run = this.sessions.get(req.body?.sessionId)?.turns.get(req.body?.turnId);
    if (!run) return refuse(req, err('invalid', 'unknown turn'));
    return reply(req, await run.cancel());
  }

  async getSessionStatus(req: Request<{ sessionId: SessionId }>): Promise<Response<SessionStatus>> {
    const bad = versionError(req);
    if (bad) return refuse(req, bad);
    const s = this.sessions.get(req.body?.sessionId);
    if (!s) return refuse(req, err('invalid', 'unknown session'));
    return reply(req, this.status(s));
  }

  async closeSession(req: Request<{ sessionId: SessionId }>): Promise<Response<SessionStatus>> {
    const bad = versionError(req);
    if (bad) return refuse(req, bad);
    const s = this.sessions.get(req.body?.sessionId);
    if (!s) return refuse(req, err('invalid', 'unknown session'));
    if (s.active && !s.active.done) return refuse(req, err('conflict', 'a turn is still running; cancel it first', true));
    s.state = 'closed';
    for (const runtimeId of s.runtime.values()) this.scopes.close(runtimeId);
    return reply(req, this.status(s));
  }

  async dispose(): Promise<void> {
    const running = [...this.sessions.values()].map((s) => s.active).filter((r): r is TurnRun => !!r && !r.done);
    await Promise.allSettled(running.map((r) => r.cancel()));
    this.scopes.closeAll();
    await this.mcp?.close();
    this.mcp = undefined;
  }

  private status(s: AppSession): SessionStatus {
    return { sessionId: s.id, state: s.state, activeTurnId: s.active && !s.active.done ? s.active.req.turnId : null };
  }

  /** Looked up for every turn (not cached), so a model switch (scripts/use-models.sh) shows on the next turn. */
  private async modelOf(agent: string): Promise<string> {
    const page = await this.client!.agents.list({ agentName: agent }, { maxRetries: 0, timeoutInSeconds: 15 });
    const found = page.data.find((a) => a.name === agent);
    return found?.manifest.model.name ?? agent;
  }
}

export function createHarness(options: HarnessOptions = {}): ForgeHarness {
  return new ForgeHarnessImpl(options);
}
