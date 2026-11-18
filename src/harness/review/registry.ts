/**
 * Review decisions waiting for the MCP tool call they authorise.
 *
 * TrueForge forwards only the tool name and arguments to the MCP server, so a decision is keyed by
 * canonicalArgsKey(args). Identical calls queue FIFO under one key, and each decision is used once.
 */
export class ReviewRegistry<D> {
  private readonly queues = new Map<string, D[]>();

  record(key: string, decision: D): void {
    const queue = this.queues.get(key);
    if (queue) queue.push(decision);
    else this.queues.set(key, [decision]);
  }

  /** Removes and returns the oldest decision for `key`, or undefined when none is waiting. */
  take(key: string): D | undefined {
    const queue = this.queues.get(key);
    if (!queue) return undefined;
    const decision = queue.shift();
    if (queue.length === 0) this.queues.delete(key);
    return decision;
  }

  pending(key: string): number {
    return this.queues.get(key)?.length ?? 0;
  }

  get size(): number {
    let n = 0;
    for (const q of this.queues.values()) n += q.length;
    return n;
  }

  /** Drops every waiting decision (turn end or cancel), returning how many were dropped. */
  clear(): number {
    const dropped = this.size;
    this.queues.clear();
    return dropped;
  }
}
