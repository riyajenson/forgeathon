// Per-TrueForge-session state shared by the turn controller and the MCP tools.
// TrueForge sends `x-tfg-session-id` on every MCP request, so a tool call is bound to exactly one scope.
import type { ApplyTextResult, CallRef, ContextReport } from '../contract-types';
import { ReviewRegistry } from '../review';

export const SESSION_HEADER = 'x-tfg-session-id';

export interface EditApproval {
  callRef: CallRef;
  proposalId: string;
  /** sha256 of the text the user reviewed; null for a new file. */
  baseSha256: string | null;
  acceptedIndices: number[];
  acceptedHunkIds: string[];
  rejectReason?: string;
}

export interface CommandApproval {
  callRef: CallRef;
  command: string;
  cwd: string;
}

export interface CommandRun {
  callRef: CallRef;
  command: string;
  exitCode: number | null;
  changedFiles: string[];
  /** The last few thousand characters of stdout and stderr (for the observed test outcome). */
  output?: string;
}

export class SessionScope {
  readonly reviews = new ReviewRegistry<EditApproval>();
  readonly commands = new ReviewRegistry<CommandApproval>();
  private readonly inFlight = new Set<Promise<unknown>>();
  private cancelledFlag = false;
  private contextAbort = new AbortController();
  semanticSearch = false;
  /** Writes (or possible writes) performed through this scope: edits applied, commands run. */
  writes = 0;
  /** Absolute workspace root of the application session (run_command cwd base). */
  workspaceRoot: string | undefined;
  /** Files changed in the editor this turn but not saved to disk (commands will not see them). */
  readonly unsavedPaths = new Set<string>();
  /** Running commands; aborted on cancel. */
  readonly running = new Set<AbortController>();
  onApplied?: (result: ApplyTextResult) => void;
  onCommand?: (run: CommandRun) => void;
  onContext?: (report: ContextReport) => void;

  constructor(readonly runtimeSessionId: string) {}

  get cancelled(): boolean {
    return this.cancelledFlag;
  }

  get signal(): AbortSignal {
    return this.contextAbort.signal;
  }

  /** Closes the approval gate: waiting decisions are dropped, no new write may start, commands are killed. */
  cancel(): void {
    this.cancelledFlag = true;
    this.contextAbort.abort();
    this.reviews.clear();
    this.commands.clear();
    for (const c of this.running) c.abort();
  }

  /** Drops approvals that no tool call has used yet; returns how many there were (each was a possible write). */
  closeApprovals(): number {
    return this.reviews.clear() + this.commands.clear();
  }

  /** Re-opens the gate for the next turn on the same runtime session. */
  resetForTurn(): void {
    this.contextAbort.abort();
    this.cancelledFlag = false;
    this.contextAbort = new AbortController();
    this.semanticSearch = false;
    this.reviews.clear();
    this.commands.clear();
    this.writes = 0;
    this.unsavedPaths.clear();
  }

  track<T>(work: Promise<T>): Promise<T> {
    this.inFlight.add(work);
    const done = () => this.inFlight.delete(work);
    work.then(done, done);
    return work;
  }

  get inFlightCount(): number {
    return this.inFlight.size;
  }

  /** Keep the session occupied until all admitted operations have actually finished. */
  async waitForIdle(): Promise<void> {
    while (this.inFlight.size) await Promise.allSettled([...this.inFlight]);
  }

  /** Resolves when every tracked tool call has settled, or after `timeoutMs`. Returns true if all settled. */
  async settle(timeoutMs: number): Promise<boolean> {
    if (this.inFlight.size === 0) return true;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); });
    const all = Promise.allSettled([...this.inFlight]).then(() => true as const);
    const result = await Promise.race([all, timeout]);
    clearTimeout(timer);
    return result;
  }
}

export class ScopeRegistry {
  private readonly scopes = new Map<string, SessionScope>();

  open(runtimeSessionId: string): SessionScope {
    let scope = this.scopes.get(runtimeSessionId);
    if (!scope) {
      scope = new SessionScope(runtimeSessionId);
      this.scopes.set(runtimeSessionId, scope);
    }
    return scope;
  }

  get(runtimeSessionId: string | undefined): SessionScope | undefined {
    return runtimeSessionId ? this.scopes.get(runtimeSessionId) : undefined;
  }

  close(runtimeSessionId: string): void {
    this.scopes.get(runtimeSessionId)?.cancel();
    this.scopes.delete(runtimeSessionId);
  }

  closeAll(): void {
    for (const id of [...this.scopes.keys()]) this.close(id);
  }
}
