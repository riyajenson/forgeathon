import { PROTOCOL_VERSION, type EventBody, type HarnessEvent, type TurnRef } from '../contract-types';

/**
 * Ordered, replayable event log for one application turn. Sequence starts at 1; exactly one 'done',
 * always last. Readers resume strictly after a cursor.
 */
export class TurnEventBuffer {
  private readonly events: HarnessEvent[] = [];
  private waiters: Array<() => void> = [];
  private closed = false;

  constructor(private readonly ref: TurnRef) {}

  get isClosed(): boolean {
    return this.closed;
  }

  get length(): number {
    return this.events.length;
  }

  emit(body: EventBody): HarnessEvent | undefined {
    if (this.closed) return undefined;
    const event = { ...this.ref, version: PROTOCOL_VERSION, sequence: this.events.length + 1, ...body } as HarnessEvent;
    this.events.push(event);
    if (body.t === 'done') this.closed = true;
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
    return event;
  }

  snapshot(): readonly HarnessEvent[] {
    return this.events;
  }

  /** Yields events with sequence > afterSequence, then follows live events until 'done'. */
  async *read(afterSequence: number): AsyncGenerator<HarnessEvent> {
    let next = Math.max(0, Math.floor(afterSequence));
    for (;;) {
      while (next < this.events.length) yield this.events[next++]!;
      if (this.closed) return;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }
}
