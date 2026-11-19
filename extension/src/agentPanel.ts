import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
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
  tools: {id: string; label: string; detail: string}[] = [];
  context?: ContextReport;
  edits: string[] = [];
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
      case 'review_request': this.reviewing = true; this.status = 'Review hunks in ' + e.proposal.path; break;
      case 'command_request': this.status = 'Waiting for command approval'; this.command = {command: e.command, cwd: e.cwd, ...(e.unrestricted ? {warning: e.warning || 'Unrestricted command'} : {})}; break;
      case 'edit_applied':
        this.reviewing = false;
        this.edits.push(e.result.path + ' | ' + e.result.status);
        if (e.result.status === 'save_failed') this.banner = 'Applied to the buffer. Save failed. Inspect the document before retrying Save.';
        break;
      case 'fallback': this.banner = 'Primary model failed: ' + e.reason + ' \u2192 switched to ' + e.toModel; break;
      case 'error': this.banner = e.error.message + '; workspace effect: ' + e.error.workspaceEffect; break;
      case 'done':
        this.status = e.summary || e.status; this.busy = this.reviewing = false; this.command = undefined;
        if (e.usage) this.usage = e.usage.inputTokens + ' input / ' + e.usage.outputTokens + ' output tokens';
        break;
    }
  }
}

type Actions = { send(text: string): Promise<void>; stop(): Promise<void>; review(): void; command(allow: boolean): void };
export class AgentPanel implements vscode.Disposable {
  state = new AgentViewState();
  private panel?: vscode.WebviewPanel;
  private timer?: NodeJS.Timeout;
  constructor(private readonly actions: Actions) {}
  start() { this.state = new AgentViewState(); this.state.busy = true; this.state.status = 'Starting'; this.refresh(); }
  finish() { this.state.busy = this.state.reviewing = false; this.refresh(); }
  event(e: HarnessEvent) { this.state.update(e); this.refresh(); }
  notice(message: string) { this.state.status = message; this.refresh(); }
  /** The command decision was given elsewhere (quick pick): retire the panel's Allow/Deny buttons. */
  commandAnswered() { if (this.state.command) { this.state.command = undefined; this.refresh(); } }
  error(message: string) { this.state.banner = message; this.refresh(); }
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
          case 'ready': this.refresh(); break;
          case 'send':
            if (!this.state.busy && typeof m.text === 'string' && m.text.trim() && m.text.length <= 32000)
              await this.actions.send(m.text);
            break;
          case 'stop': await this.actions.stop(); break;
          case 'review': this.actions.review(); break;
          case 'allow': case 'deny':
            if (this.state.command) { this.state.command = undefined; this.actions.command(m.action === 'allow'); this.refresh(); }
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
<p id="status" role="status"></p><p id="model"></p><p id="banner" role="alert" hidden></p><button id="trace" hidden>Open TrueForge session</button>
<section id="cmd" hidden><h2>Command approval</h2><pre id="cmdText"></pre><button id="allow">Allow once</button> <button id="deny">Deny</button></section>
<pre id="text"></pre><section id="activity" hidden><h2>Tool activity</h2><ul id="tools"></ul></section>
<section id="context" hidden><h2>Context</h2><p id="budget"></p><ul id="selected"></ul><h2 id="skippedTitle">Skipped</h2><ul id="skipped"></ul></section>
<section id="changes" hidden><h2>Reviewed edits</h2><ul id="edits"></ul></section>
<script nonce="${nonce}" src="${script}"></script></body></html>`;
    panel.onDidDispose(() => { this.panel = undefined; });
  }
  refresh() {
    if (!this.panel || this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.panel?.webview.postMessage(this.state); }, 40);
  }
  dispose() { if (this.timer) clearTimeout(this.timer); this.panel?.dispose(); }
}
