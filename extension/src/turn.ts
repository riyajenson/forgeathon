import { randomUUID } from 'node:crypto';
import type { ForgeHarness, HarnessEvent, PromptContext, Request, ReviewDecision, TurnRef, Version } from 'forge-harness';
import { EditReview } from './review';

export type TurnView = {
  event(e: HarnessEvent): void;
  review(p: Extract<HarnessEvent, {t: 'review_request'}>['proposal']): Promise<ReviewDecision | undefined>;
  command(e: Extract<HarnessEvent, {t: 'command_request'}>): Promise<boolean>;
  cancelReview(): void;
  notice(text: string): void;
};
type Active = { stopped: boolean; ref?: TurnRef; last: number; submitted: boolean };
export class TurnController {
  private active?: Active;
  private conversation?: string;
  constructor(private harness: ForgeHarness, private version: Version, private root: string,
    private edits: EditReview, private view: TurnView) {}
  /** The next agent turn starts a new TrueForge session instead of continuing the conversation. */
  newConversation() { if (!this.active) this.conversation = undefined; }
  private envelope<T>(body: T): Request<T> { return { version: this.version, requestId: randomUUID(), body }; }
  async run(mode: 'inline' | 'agent', instruction: string, context: PromptContext, options: {autoApproveSafeCommands?: boolean; commandBudget?: number} = {}) {
    if (this.active) throw new Error('A turn is already in progress');
    const a: Active = { stopped: false, last: 0, submitted: false };
    this.active = a;
    let sessionId = mode === 'agent' ? this.conversation : undefined;
    try {
      if (!sessionId) {
        const session = await this.harness.createSession(this.envelope({workspaceRoot: this.root}));
        if (!session.ok) throw new Error(session.error.message);
        sessionId = session.body.sessionId;
        if (mode === 'agent') this.conversation = sessionId;
      }
      if (a.stopped) return;
      const ref = {sessionId, turnId: randomUUID()};
      a.ref = ref;
      this.edits.begin(ref);
      const turn = await this.harness.submitTurn(this.envelope({...ref, ...context, mode, instruction,
        ...(options.autoApproveSafeCommands === true ? {autoApproveSafeCommands: true} : {}),
        ...(options.commandBudget === undefined ? {} : {commandBudget: options.commandBudget})}));
      if (!turn.ok) throw new Error(turn.error.message);
      a.submitted = true;
      if (a.stopped) await this.stop();
      let promptOpen = false;
      let reviewError: Error | undefined;
      const answer = async (e: Extract<HarnessEvent, {t:'review_request' | 'command_request'}>) => {
        if (promptOpen) throw new Error('Overlapping approval requests');
        promptOpen = true;
        let decision: ReviewDecision | undefined;
        try {
          if (e.t === 'review_request') {
            if (e.proposal.turnId !== ref.turnId || e.proposal.sessionId !== ref.sessionId)
              throw new Error('Invalid review identity');
            decision = await this.view.review(e.proposal);
          } else {
            decision = {...ref, kind:'command', callId:e.callId, allow:await this.view.command(e)};
          }
        } finally { promptOpen = false; }
        if (!decision || a.stopped || this.active !== a || !this.edits.isActive(ref)) return;
        const reply = await this.harness.submitReview(this.envelope(decision));
        if (!reply.ok) throw new Error(reply.error.message);
      };
      for await (const packet of this.harness.stream(this.envelope({...ref, afterSequence: 0}))) {
        if (!packet.ok) throw new Error(packet.error.message);
        const e = packet.body;
        if (e.version !== this.version || e.sessionId !== ref.sessionId || e.turnId !== ref.turnId)
          throw new Error('Unexpected turn or protocol version');
        if (e.sequence <= a.last) continue;
        if (e.sequence !== ++a.last) throw new Error('Missing turn events');
        if (e.t === 'done') { this.view.event(e); if (reviewError) throw reviewError; return; }
        if (a.stopped && e.t !== 'edit_applied' && e.t !== 'error') continue;
        this.view.event(e);
        // An auto-approved command was already allowed by the harness: it is only shown, never prompted.
        if (e.t === 'review_request' || (e.t === 'command_request' && !e.autoApproved)) {
          // Keep consuming the stream while the user reviews. A terminal event can revoke this prompt.
          void answer(e).catch(async error => {
            if (this.active !== a || a.stopped) return;
            reviewError = error instanceof Error ? error : new Error('Approval failed');
            this.view.notice(reviewError.message);
            try { await this.stop(); } catch { this.view.notice('Stop confirmation unavailable'); }
          });
        }
      }
      throw new Error('Stream closed before the terminal event');
    } catch (err) {
      if (a.ref && a.submitted && !a.stopped) await this.stop();
      throw err;
    } finally {
      this.edits.end(); this.view.cancelReview();
      this.active = undefined;
      if (sessionId && mode === 'inline') await this.harness.closeSession(this.envelope({sessionId}));
    }
  }
  async stop() {
    const a = this.active;
    if (!a) return;
    a.stopped = true;
    this.edits.end();
    this.view.cancelReview();
    this.view.notice('Stopping...');
    if (a.ref && a.submitted) {
      const reply = await this.harness.cancel(this.envelope(a.ref));
      if (!reply.ok || reply.body === 'unconfirmed') this.view.notice('Stop requested; confirmation pending');
    }
  }
}
