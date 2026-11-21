// The shared contracts (contracts/, protocol 0.4.5; see contracts/protocol.ts) as seen by the harness. All contract shapes come from
// contracts/; this file only adds two derived helper types the contracts do not export.
import type { EditorBridge } from '../../contracts/edits';
import type { HarnessEvent } from '../../contracts/events';
import type { TurnRef, Version } from '../../contracts/protocol';

export * from '../../contracts/protocol';
export type * from '../../contracts/context';
export type * from '../../contracts/edits';
export type * from '../../contracts/events';
export type * from '../../contracts/session';
export type * from '../../contracts/tools';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A HarnessEvent without the envelope fields the event buffer adds. */
export type EventBody = DistributiveOmit<HarnessEvent, keyof TurnRef | 'version' | 'sequence'>;
export type ListFilesOptions = NonNullable<Parameters<EditorBridge['listFiles']>[0]>;
export type { Version };
