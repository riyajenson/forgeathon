import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { ContextReport, HarnessEvent } from 'forge-harness';
import { proposalWarnings } from './destructive';
import { verificationLine } from './verification';
import { contextView, type ContextView } from './contextView';

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
  /** The report grouped for reading (pins, files, skipped by reason); the full lists stay under "All entries". */
  contextView?: ContextView;
  edits: string[] = [];
  /** Per file in this turn: proposals reviewed, hunks proposed and accepted, last apply status. */
  files: Record<string, {reviews: number; hunks: number; accepted: number; status: string}> = {};
  /** Set when the turn ends: every file the turn changed (then reviewed files left unchanged), on one screen. */
  summary: string[] = [];
  command?: {command: string; cwd: string; warning?: string; facts?: string};
  /** Set when the turn stopped on a rate limit or a stall: Resume is offered from `at` (ms since epoch). */
  resume?: {at: number; files: string[]; reason: 'rate_limited' | 'stalled'};
  /** The user asked to resume automatically once, when the wait ends (cancelled by Stop, a new turn or closing the panel). */
  autoResume = false;
  /** Proposals in this turn with hunks that delete a whole class or function. */
  warnings: string[] = [];
  /** Set when an agent turn ends: the observed outcome of its last test command, shown next to the model's summary. */
  tests = '';
  /** Set when an agent turn that changed files ends: Verified, or Unverified with the reason (see verification.ts). */
  verification = '';
  /** Set when the turn fell back: one card with both models, the reason and the workspace effect (see recoveryCard). */
  recovery = '';
  private compaction?: {id: string; label: string; detail: string};

  update(e: HarnessEvent) {
    switch (e.t) {
      case 'session': this.trace = e.traceUrl; this.model = e.model + ' (' + e.agentName + ')'; break;
      case 'turn_started': this.status = 'Running'; break;
      case 'status':
        this.status = e.detail || e.state;
        // Compaction also stays in the activity list: started (compacting), then finished (the next status with detail).
        if (e.state === 'compacting') {
          this.compaction = {id: 'compaction:' + this.tools.length, label: 'Context compaction', detail: e.detail || 'running'};
          this.tools.push(this.compaction);
        } else if (this.compaction && e.detail) {
          this.compaction.detail = e.detail; this.compaction = undefined;
        }
        break;
      case 'text': this.text = (this.text + e.delta).slice(-100000); break;
      case 'tool_call':
        if (e.tool !== 'internal') this.tools.push({id:e.callId, label:e.displayName, detail:e.summary});
        break;
      case 'tool_result': {
        const item = this.tools.find(tool => tool.id === e.callId);
        if (item) item.detail = (e.ok ? 'Done: ' : 'Failed: ') + e.summary;
        break;
      }
      case 'context_report': this.context = e.report; this.contextView = contextView(e.report); break;
      case 'review_request': {
        this.reviewing = true; this.status = 'Review hunks in ' + e.proposal.path;
        const f = this.files[e.proposal.path] ??= {reviews: 0, hunks: 0, accepted: 0, status: ''};
        f.reviews++; f.hunks += e.proposal.hunks.length;
        for (const w of proposalWarnings(e.proposal)) this.warnings.push(e.proposal.path + ': ' + w);
        break;
      }
      case 'command_request':
        if (e.autoApproved) {
          this.status = 'auto-approved: ' + e.command;
          this.tools.push({id:'auto:' + e.callId, label:'auto-approved: ' + e.command, detail:'cwd: ' + e.cwd});
          break;
        }
        this.status = 'Waiting for command approval'; this.command = {command: e.command, cwd: e.cwd, facts: commandFacts(e.unrestricted === true), ...(e.unrestricted ? {warning: e.warning || 'Unrestricted command'} : {})}; break;
      case 'command_budget_reached': {
        // Refused by the harness without a prompt: the model was told to stop running commands (or tests).
        const which = e.kind === 'test' ? 'test-command budget' : 'command budget';
        this.status = which + ' reached';
        this.tools.push({id:'budget:' + e.callId, label:which + ' reached (' + e.budget + ' per turn): ' + e.command, detail:'not run'});
        break;
      }
      case 'subagent':
        if (e.phase === 'started') this.tools.push({id:'subagent:' + e.threadId, label:'Sub-agent: ' + e.name, detail:e.task || 'running'});
        else {
          const item = this.tools.find(tool => tool.id === 'subagent:' + e.threadId);
          const detail = e.ok ? 'Done' : 'Failed' + (e.error ? ': ' + e.error : '');
          if (item) item.detail = detail; else this.tools.push({id:'subagent:' + e.threadId, label:'Sub-agent: ' + e.name, detail});
        }
        break;
      case 'resumable': this.resume = {at: Date.now() + e.retryAfterMs, files: e.changedFiles, reason: e.reason}; break;
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
      case 'fallback': this.banner = 'Primary model failed: ' + e.reason + ' \u2192 switched to ' + e.toModel; this.recovery = recoveryCard(e); break;
      case 'error': this.banner = e.error.message + '; workspace effect: ' + e.error.workspaceEffect; break;
      case 'done':
        this.status = e.summary || e.status; this.outcome = e.status; this.busy = this.reviewing = false; this.command = undefined;
        if (e.usage) this.usage = e.usage.inputTokens + ' input / ' + e.usage.outputTokens + ' output tokens';
        this.summary = this.fileSummary();
        if (e.status === 'cancelled') {
          const saved = this.summary.filter((l) => !l.endsWith('| not changed')).length;
          this.status = 'Stopped \u00b7 settled: ' + (saved ? saved + (saved === 1 ? ' file' : ' files') + ' changed before the stop (listed below); nothing else will run'
            : 'no change was applied in this turn; nothing else will run');
        }
        this.tests = testsLine(e.tests);
        this.verification = verificationLine(e.status, e.tests, this.summary.filter((l) => !l.endsWith('| not changed')).length, this.text);
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

/** Two independent facts for a command approval: the allowlist classification, and the isolation it will run under. */
export function commandFacts(unrestricted: boolean): string {
  return (unrestricted ? '\u26a0 Outside the verification allowlist (pytest, python -m pytest, python -c, flask, git status, git diff)'
    : '\u2713 On the verification allowlist') +
    ' \u00b7 Sandbox: active (bubblewrap: read-only workspace, no network, no home directory, no API keys; refused if unavailable)';
}

/** The fallback as one card: which model failed and why, which model took over, and what that means for the workspace. */
export function recoveryCard(e: Extract<HarnessEvent, {t: 'fallback'}>): string {
  return e.fromModel + ' \u2192 ' + e.toModel + ' \u2014 reason: ' + e.reason + '. The turn restarted on the fallback model in a fresh ' +
    'TrueForge session (its own trace). The failed attempt changed no files: Forge falls back only before any edit or command ' +
    'has taken effect.';
}

/** The observed test outcome as one line: what actually ran, not what the model says. */
export function testsLine(t: Extract<HarnessEvent, {t: 'done'}>['tests']): string {
  if (!t) return '';
  if (t.status === 'not_run') return 'Tests (observed): not run in this turn';
  const counts = t.status === 'passed' ? 'passed' : (t.failed ? t.failed + ' failed' : 'failed (exit ' + t.exitCode + ')');
  const result = counts + (t.summary ? ' \u2014 ' + t.summary : '');
  const cmd = t.command ? ' \u2014 $ ' + t.command : '';
  if (t.editedAfter?.length) return 'Tests (observed): edited after last test run (last result: ' + result + ')' + cmd + ' \u2014 changed since: ' + t.editedAfter.join(', ');
  return 'Tests (observed): ' + result + cmd;
}

type Actions = { send(text: string): Promise<void>; stop(): Promise<void>; review(): void; command(allow: boolean): void; resume(): Promise<void>; attach?(): Promise<string>; undoTurn?(): Promise<void> };
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
  private autoResumeTimer?: NodeJS.Timeout;
  /** Schedules (or cancels) one Resume when the suggested wait ends; it fires only if that same turn is still resumable. */
  setAutoResume(on: boolean) {
    this.cancelAutoResume();
    const target = this.state.resume;
    this.state.autoResume = on && target !== undefined && !this.state.busy;
    if (this.state.autoResume && target) {
      this.autoResumeTimer = setTimeout(() => {
        this.autoResumeTimer = undefined;
        if (this.state.resume !== target || !this.state.autoResume || this.state.busy) return;
        this.state.autoResume = false;
        void this.actions.resume();
      }, Math.max(0, target.at - Date.now()));
    }
    this.refreshControl();
  }
  private cancelAutoResume() { if (this.autoResumeTimer) clearTimeout(this.autoResumeTimer); this.autoResumeTimer = undefined; this.state.autoResume = false; }
  start() {
    const eventAt = performance.now();
    const wallAt = Date.now();
    this.cancelAutoResume();
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
  /** True while the Forge Agent panel is shown, so notices need not be repeated outside it. */
  get visible(): boolean { return this.panel?.visible === true; }
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
          case 'stop': this.cancelAutoResume(); await this.actions.stop(); break;
          case 'undoTurn': if (!this.state.busy) await this.actions.undoTurn?.(); break;
          case 'autoResume': this.setAutoResume(!this.state.autoResume); break;
          case 'attach': { const mentions = await this.actions.attach?.(); if (mentions && panel === this.panel) void panel.webview.postMessage({insertMentions: mentions}); break; }
          case 'resume':
            // Offered only after a rate limit, once the suggested wait has passed.
            if (!this.state.busy && this.state.resume && Date.now() >= this.state.resume.at) await this.actions.resume();
            break;
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
button:disabled{opacity:.55} pre,li{white-space:pre-wrap;overflow-wrap:anywhere} #banner,#verification.unverified{border-left:3px solid var(--vscode-editorWarning-foreground);padding-left:8px} #verification.verified{border-left:3px solid var(--vscode-testing-iconPassed,var(--vscode-charts-green));padding-left:8px}
h2{font-size:1em;margin-top:18px} ul{padding-left:18px} :focus-visible{outline:1px solid var(--vscode-focusBorder)}</style></head>
<body><label for="task">Task</label><textarea id="task" rows="3" maxlength="32000"></textarea>
<button id="attach" title="Attach files or symbols as @file:/@symbol: mentions">Attach\u2026</button> <button id="send">Send</button> <button id="stop" disabled>Stop</button> <button id="review" hidden>Review hunks</button>
<p id="status" role="status"></p><p id="verification" role="alert" hidden></p><p id="tests" hidden></p><section id="resumeBox" hidden><p id="resumeText"></p><button id="resume">Resume</button> <button id="autoResume">Resume when ready</button></section><section id="turnFiles" hidden><h2 id="turnFilesTitle"></h2><ul id="summary"></ul><button id="undoTurn" hidden title="Restore every file this turn changed (checked first; nothing is undone if one was edited since)">Undo this turn\u2019s changes</button></section><section id="warnings" hidden><h2>Destructive hunks</h2><ul id="warningList"></ul></section><p id="model"></p><p id="banner" role="alert" hidden></p><section id="recovery" hidden><h2>Recovered by fallback</h2><p id="recoveryText"></p></section><button id="trace" hidden>Open TrueForge session</button>
<section id="context" hidden><h2>Context selected for this turn</h2><p id="budget"></p><p>Selected files and reasons shown here were sent to the agent.</p><h3 id="pinnedTitle">Pinned by you</h3><ul id="pinned"></ul><h3>Files (in rank order)</h3><ul id="files"></ul><h3 id="skippedGroupsTitle">Not included, by reason</h3><ul id="skippedGroups"></ul><details><summary>All entries</summary><ul id="selected"></ul><h2 id="skippedTitle">Not included</h2><ul id="skipped"></ul></details></section>
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
    this.cancelAutoResume();
    this.clearTextTimer();
    this.pendingTextEvents.length = 0;
    this.pendingRenders.clear();
    const panel = this.panel;
    this.panel = undefined;
    panel?.dispose();
  }
}
