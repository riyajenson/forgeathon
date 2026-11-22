import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { ContextReport, HarnessEvent } from 'forge-harness';

export class AgentViewState {
  text = '';
  status = 'Ready';
  banner = '';
  trace = '';
  model = '';
  usage = '';
  busy = false;
  reviewing = false;
  /** How the last turn ended ('done', 'error' or 'cancelled'); empty while it runs. */
  outcome = '';
  tools: {id: string; label: string; detail: string}[] = [];
  context?: ContextReport;
  edits: string[] = [];
  /** Per file in this turn: proposals reviewed, hunks proposed and accepted, last apply status. */
  files: Record<string, {reviews: number; hunks: number; accepted: number; status: string}> = {};
  /** Set when the turn ends: every file the turn changed (then reviewed files left unchanged), on one screen. */
  summary: string[] = [];
  command?: {command: string; cwd: string; warning?: string};

  update(e: HarnessEvent) {
    switch (e.t) {
      case 'session': this.trace = e.traceUrl; this.model = e.model + ' (' + e.agentName + ')'; break;
      case 'turn_started': this.status = 'Running'; break;
      case 'status': this.status = e.detail || e.state; break;
      case 'text': this.text = (this.text + e.delta).slice(-100000); break;
      case 'tool_call':
        if (e.tool !== 'internal') this.tools.push({id:e.callId, label:e.displayName, detail:e.summary});
        break;
      case 'tool_result': {
        const item = this.tools.find(tool => tool.id === e.callId);
        if (item) item.detail = (e.ok ? 'Done: ' : 'Failed: ') + e.summary;
        break;
      }
      case 'context_report': this.context = e.report; break;
      case 'review_request': {
        this.reviewing = true; this.status = 'Review hunks in ' + e.proposal.path;
        const f = this.files[e.proposal.path] ??= {reviews: 0, hunks: 0, accepted: 0, status: ''};
        f.reviews++; f.hunks += e.proposal.hunks.length;
        break;
      }
      case 'command_request':
        if (e.autoApproved) {
          this.status = 'auto-approved: ' + e.command;
          this.tools.push({id:'auto:' + e.callId, label:'auto-approved: ' + e.command, detail:'cwd: ' + e.cwd});
          break;
        }
        this.status = 'Waiting for command approval'; this.command = {command: e.command, cwd: e.cwd, ...(e.unrestricted ? {warning: e.warning || 'Unrestricted command'} : {})}; break;
      case 'command_budget_reached':
        // Refused by the harness without a prompt: the model was told to stop running commands.
        this.status = 'command budget reached';
        this.tools.push({id:'budget:' + e.callId, label:'command budget reached (' + e.budget + ' per turn): ' + e.command, detail:'not run'});
        break;
      case 'edit_applied':
        this.reviewing = false;
        this.edits.push(e.result.path + ' | ' + e.result.status);
        {
          const f = this.files[e.result.path] ??= {reviews: 0, hunks: 0, accepted: 0, status: ''};
          f.status = e.result.status;
          if ('appliedHunkIds' in e.result) f.accepted += e.result.appliedHunkIds.length;
        }
        if (e.result.status === 'save_failed') this.banner = 'Applied to the buffer. Save failed. Inspect the document before retrying Save.';
        break;
      case 'fallback': this.banner = 'Primary model failed: ' + e.reason + ' \u2192 switched to ' + e.toModel; break;
      case 'error': this.banner = e.error.message + '; workspace effect: ' + e.error.workspaceEffect; break;
      case 'done':
        this.status = e.summary || e.status; this.outcome = e.status; this.busy = this.reviewing = false; this.command = undefined;
        if (e.usage) this.usage = e.usage.inputTokens + ' input / ' + e.usage.outputTokens + ' output tokens';
        this.summary = this.fileSummary();
        break;
    }
  }
  private fileSummary() {
    const all = Object.entries(this.files);
    const counts = (f: {reviews: number; hunks: number; accepted: number}) =>
      f.reviews + (f.reviews === 1 ? ' review, ' : ' reviews, ') + f.accepted + '/' + f.hunks + ' hunks accepted';
    return [...all.filter(([, f]) => f.accepted > 0).map(([path, f]) => path + ' | ' + counts(f) + ' | ' + f.status),
      ...all.filter(([, f]) => f.accepted === 0).map(([path, f]) => path + ' | ' + counts(f) + ' | not changed')];
  }
}

type Actions = { send(text: string): Promise<void>; stop(): Promise<void>; review(): void; command(allow: boolean): void };
export class AgentPanel implements vscode.Disposable {
  state = new AgentViewState();
  private panel?: vscode.WebviewPanel;
  private textTimer?: NodeJS.Timeout;
  private renderSequence = 0;
  private readonly pendingTextEvents: Array<{ eventAt: number; wallAt: number }> = [];
  private readonly pendingRenders = new Map<number, {
    kind: 'control' | 'text'; controlEventAt?: number; textEvents: Array<{ eventAt: number; wallAt: number }>;
  }>();
  private readonly controlLatencies: number[] = [];
  private readonly textLatencies: number[] = [];
  private readonly controlHostAcks: number[] = [];
  private readonly textHostAcks: number[] = [];
  private readonly controlWebviewFrames: number[] = [];
  private readonly textWebviewFrames: number[] = [];
  private readonly controlWebviewDom: number[] = [];
  private readonly textWebviewDom: number[] = [];
  constructor(private readonly actions: Actions) {}
  start() {
    const eventAt = performance.now();
    const wallAt = Date.now();
    this.state = new AgentViewState(); this.state.busy = true; this.state.status = 'Starting'; this.refreshControl(eventAt, wallAt);
  }
  finish() {
    const eventAt = performance.now();
    const wallAt = Date.now();
    this.state.busy = this.state.reviewing = false; this.refreshControl(eventAt, wallAt);
  }
  event(e: HarnessEvent) {
    const eventAt = performance.now();
    const wallAt = Date.now();
    this.state.update(e);
    if (e.t === 'text') {
      // A closed panel has no text frame to measure or flush. The state still
      // accumulates text, so the next panel snapshot will include it.
      if (this.panel) {
        this.pendingTextEvents.push({ eventAt, wallAt });
        if (this.pendingTextEvents.length > 512) this.pendingTextEvents.shift();
        this.refreshText();
      }
    } else this.refreshControl(eventAt, wallAt);
  }
  notice(message: string) { const eventAt = performance.now(), wallAt = Date.now(); this.state.status = message; this.refreshControl(eventAt, wallAt); }
  /** The command decision was given elsewhere (quick pick): retire the panel's Allow/Deny buttons. */
  commandAnswered() { if (this.state.command) { const eventAt = performance.now(), wallAt = Date.now(); this.state.command = undefined; this.refreshControl(eventAt, wallAt); } }
  error(message: string) { const eventAt = performance.now(), wallAt = Date.now(); this.state.banner = message; this.refreshControl(eventAt, wallAt); }
  open() {
    if (this.panel) { this.panel.reveal(vscode.ViewColumn.Beside); return; }
    const media = vscode.Uri.joinPath(vscode.Uri.file(__dirname), '..', 'media');
    const panel = this.panel = vscode.window.createWebviewPanel('forgeathon.agent', 'Forge Agent',
      {viewColumn:vscode.ViewColumn.Beside, preserveFocus:false}, {enableScripts:true, localResourceRoots:[media]});
    const view = panel.webview, nonce = randomBytes(16).toString('hex');
    const script = view.asWebviewUri(vscode.Uri.joinPath(media,'agent.js'));
    view.onDidReceiveMessage(async m => {
      if (panel !== this.panel || !m || typeof m !== 'object') return;
      try {
        switch (m.action) {
          case 'ready': this.refreshControl(); break;
          case 'rendered': this.acknowledgeRender(m.sequence, m.frameMs, m.domMs, m.visibility, m.eventToFrameMs, m.textEventToFrameMs); break;
          case 'send':
            if (!this.state.busy && typeof m.text === 'string' && m.text.trim() && m.text.length <= 32000)
              await this.actions.send(m.text);
            break;
          case 'stop': await this.actions.stop(); break;
          case 'review': this.actions.review(); break;
          case 'allow': case 'deny':
            if (this.state.command) {
              const eventAt = performance.now(), wallAt = Date.now();
              this.state.command = undefined; this.actions.command(m.action === 'allow'); this.refreshControl(eventAt, wallAt);
            }
            break;
          case 'trace': {
            const uri = vscode.Uri.parse(this.state.trace, true);
            if (uri.scheme === 'http' && /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(uri.authority))
              await vscode.env.openExternal(uri);
            break;
          }
        }
      } catch (error) { this.error(error instanceof Error ? error.message : 'Request failed'); }
    });
    view.html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'">
<style nonce="${nonce}">body{font:var(--vscode-font-size) var(--vscode-font-family);color:var(--vscode-foreground);padding:12px}
textarea{display:block;box-sizing:border-box;width:100%;margin:6px 0;padding:8px;color:var(--vscode-input-foreground);background:var(--vscode-input-background)}
button{color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0;padding:5px 10px;cursor:pointer}
button:disabled{opacity:.55} pre,li{white-space:pre-wrap;overflow-wrap:anywhere} #banner{border-left:3px solid var(--vscode-editorWarning-foreground);padding-left:8px}
h2{font-size:1em;margin-top:18px} ul{padding-left:18px} :focus-visible{outline:1px solid var(--vscode-focusBorder)}</style></head>
<body><label for="task">Task</label><textarea id="task" rows="3" maxlength="32000"></textarea>
<button id="send">Send</button> <button id="stop" disabled>Stop</button> <button id="review" hidden>Review hunks</button>
<p id="status" role="status"></p><section id="turnFiles" hidden><h2 id="turnFilesTitle"></h2><ul id="summary"></ul></section><p id="model"></p><p id="banner" role="alert" hidden></p><button id="trace" hidden>Open TrueForge session</button>
<section id="context" hidden><h2>Context selected for this turn</h2><p id="budget"></p><p>Selected files and reasons shown here were sent to the agent.</p><ul id="selected"></ul><h2 id="skippedTitle">Not included</h2><ul id="skipped"></ul></section>
<section id="cmd" hidden><h2>Command approval</h2><pre id="cmdText"></pre><button id="allow">Allow once</button> <button id="deny">Deny</button></section>
<pre id="text"></pre><section id="activity" hidden><h2>Tool activity</h2><ul id="tools"></ul></section>
<section id="changes" hidden><h2>Reviewed edits</h2><ul id="edits"></ul></section>
<script nonce="${nonce}" src="${script}"></script></body></html>`;
    panel.onDidDispose(() => {
      if (this.panel !== panel) return;
      this.panel = undefined;
      this.clearTextTimer();
      this.pendingTextEvents.length = 0;
      this.pendingRenders.clear();
    });
  }

  private clearTextTimer() {
    if (this.textTimer) clearTimeout(this.textTimer);
    this.textTimer = undefined;
  }

  private refreshText() {
    if (!this.panel || this.textTimer) return;
    this.textTimer = setTimeout(() => {
      this.textTimer = undefined;
      this.postRender('text');
    }, 16);
  }

  private refreshControl(eventAt?: number, wallAt?: number) {
    this.clearTextTimer();
    this.postRender('control', eventAt, wallAt);
  }

  private postRender(kind: 'control' | 'text', controlEventAt?: number, controlEventWallAt?: number) {
    const panel = this.panel;
    if (!panel) return;
    const sequence = ++this.renderSequence;
    // Keep diagnostic bookkeeping bounded if the webview stops acknowledging
    // frames; this never drops a render message sent to the webview.
    if (this.pendingRenders.size >= 512) {
      const oldest = this.pendingRenders.keys().next().value;
      if (oldest !== undefined) this.pendingRenders.delete(oldest);
    }
    const textEvents = this.pendingTextEvents.splice(0);
    this.pendingRenders.set(sequence, {
      kind,
      ...(controlEventAt === undefined ? {} : { controlEventAt }),
      textEvents
    });
    const state = {
      ...this.state,
      renderSequence: sequence,
      ...(controlEventWallAt === undefined ? {} : { renderEventWallAt: controlEventWallAt }),
      ...(textEvents.length ? { renderTextEventWallAt: textEvents[0]!.wallAt } : {})
    };
    try {
      void Promise.resolve(panel.webview.postMessage(state)).then(sent => {
        if (!sent) this.pendingRenders.delete(sequence);
      }, () => this.pendingRenders.delete(sequence));
    } catch { this.pendingRenders.delete(sequence); }
  }

  private acknowledgeRender(sequence: unknown, frameMs?: unknown, domMs?: unknown, visibility?: unknown, eventToFrameMs?: unknown, textEventToFrameMs?: unknown) {
    if (typeof sequence !== 'number' || !Number.isInteger(sequence)) return;
    const render = this.pendingRenders.get(sequence);
    if (!render) return;
    this.pendingRenders.delete(sequence);
    const frameAt = performance.now();
    if (render.controlEventAt !== undefined) this.recordLatency(this.controlHostAcks, frameAt - render.controlEventAt);
    for (const event of render.textEvents) this.recordLatency(this.textHostAcks, frameAt - event.eventAt);
    if (typeof eventToFrameMs === 'number' && Number.isFinite(eventToFrameMs) && eventToFrameMs >= 0)
      this.recordLatency(this.controlLatencies, eventToFrameMs);
    if (render.textEvents.length && typeof textEventToFrameMs === 'number' && Number.isFinite(textEventToFrameMs) && textEventToFrameMs >= 0)
      this.recordLatency(this.textLatencies, textEventToFrameMs);
    if (typeof frameMs === 'number' && Number.isFinite(frameMs) && frameMs >= 0) {
      if (render.kind === 'control' && render.controlEventAt !== undefined) this.recordLatency(this.controlWebviewFrames, frameMs);
      else if (render.textEvents.length) this.recordLatency(this.textWebviewFrames, frameMs);
    }
    if (typeof domMs === 'number' && Number.isFinite(domMs) && domMs >= 0) {
      if (render.kind === 'control' && render.controlEventAt !== undefined) this.recordLatency(this.controlWebviewDom, domMs);
      else if (render.textEvents.length) this.recordLatency(this.textWebviewDom, domMs);
    }
  }

  private recordLatency(samples: number[], value: number) {
    samples.push(Math.max(0, value));
    if (samples.length > 512) samples.shift();
  }

  private summarize(samples: readonly number[]) {
    const sorted = [...samples].sort((a, b) => a - b);
    const percentile = (p: number) => sorted.length
      ? Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)]!)
      : 0;
    // The two largest samples too: a gate can then allow one outlier (a GC pause, a font load) but not a pattern.
    const top = (i: number) => sorted.length > i ? Math.round(sorted[sorted.length - 1 - i]!) : 0;
    return { count: sorted.length, p50Ms: percentile(0.5), p95Ms: percentile(0.95), maxMs: top(0), secondMaxMs: top(1) };
  }

  /** Numeric event-to-animation-frame latency only; message text is never retained in these metrics. */
  getRenderMetrics() {
    return {
      control: {
        ...this.summarize(this.controlLatencies),
        webviewFrame: this.summarize(this.controlWebviewFrames),
        webviewDom: this.summarize(this.controlWebviewDom),
        hostAck: this.summarize(this.controlHostAcks)
      },
      text: {
        ...this.summarize(this.textLatencies),
        webviewFrame: this.summarize(this.textWebviewFrames),
        webviewDom: this.summarize(this.textWebviewDom),
        hostAck: this.summarize(this.textHostAcks)
      }
    };
  }

  dispose() {
    this.clearTextTimer();
    this.pendingTextEvents.length = 0;
    this.pendingRenders.clear();
    const panel = this.panel;
    this.panel = undefined;
    panel?.dispose();
  }
}
