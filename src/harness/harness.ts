import type { ForgeHarness } from './contract-types';

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
}

export function createHarness(_options: HarnessOptions = {}): ForgeHarness {
  const notYet = (): never => {
    throw new Error('forge-harness: createHarness is not implemented yet (harness/p2a-turn-runner in progress)');
  };
  return {
    start: async () => notYet(),
    createSession: async () => notYet(),
    submitTurn: async () => notYet(),
    stream: () => notYet(),
    submitReview: async () => notYet(),
    cancel: async () => notYet(),
    getSessionStatus: async () => notYet(),
    closeSession: async () => notYet(),
    dispose: async () => undefined,
  };
}
