// Loads the TrueForge SDK. Its CommonJS build does not load (the package declares "type": "module"),
// so the ESM entry is loaded with a dynamic import, which TypeScript keeps as import() under node16.
const load = () => import('@truefoundry/trueforge-sdk');

export type TrueForgeSdk = Awaited<ReturnType<typeof load>>;
export type TrueForgeClient = InstanceType<TrueForgeSdk['TrueForge']>;

let cached: Promise<TrueForgeSdk> | undefined;

export function loadSdk(): Promise<TrueForgeSdk> {
  cached ??= load();
  return cached;
}

export async function createClient(baseUrl: string): Promise<{ sdk: TrueForgeSdk; client: TrueForgeClient }> {
  const sdk = await loadSdk();
  // Generous request timeout: a turn stream stays open for the whole turn; the watchdog handles stalls.
  const client = new sdk.TrueForge({ baseUrl, timeoutInSeconds: 3600, maxRetries: 0 });
  return { sdk, client };
}

/** Loose structural view of a TrueForge turn event. Fields are validated where they are used. */
export interface TfEvent {
  type: string;
  id: string;
  [key: string]: unknown;
}

export interface TfToolCall {
  id: string;
  function?: { name?: string; arguments?: string };
  toolInfo?: { type?: string; name?: string; serverName?: string };
}

/** Link to the session in the TrueForge UI (verified route of the 0.185.1 frontend). */
export function traceUrl(baseUrl: string, runtimeSessionId: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/sessions?view=sessions&sessionId=${encodeURIComponent(runtimeSessionId)}`;
}
