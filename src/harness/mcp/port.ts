// The editor capabilities the harness uses. This is the contract's EditorBridge (amendment R1);
// the extension implements it and passes it to ForgeHarness.start().
import type { EditorBridge, ListFilesOptions } from '../contract-types';

export type EditorPort = EditorBridge;
export type { ListFilesOptions, ApplyTextRequest, ApplyTextResult } from '../contract-types';

export interface TextSnapshot {
  text: string;
  sha256: string;
}

export function listOptions(prefix?: string, limit?: number): ListFilesOptions | undefined {
  if (prefix === undefined && limit === undefined) return undefined;
  return { ...(prefix !== undefined ? { prefix } : {}), ...(limit !== undefined ? { limit } : {}) };
}
