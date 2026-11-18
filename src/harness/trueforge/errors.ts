// Classifies turn.done(error) messages. Message formats verified against TrueForge 0.185.1 (spike/FINDINGS.md):
//   [Model Error] Request failed (401): <provider message>
//   [Model Error] Cannot connect to API: connect ECONNREFUSED 127.0.0.1:47799
//   [Model Error] Cannot connect to API: Connect Timeout Error (attempted address: ..., timeout: 3000ms)

export type TurnErrorClass = 'MODEL_AUTH' | 'MODEL_UNAVAILABLE' | 'OTHER';

export function classifyTurnError(message: string | undefined): TurnErrorClass {
  const m = message ?? '';
  if (!m.includes('[Model Error]')) return 'OTHER';
  if (m.includes('(401)') || m.includes('(403)')) return 'MODEL_AUTH';
  if (m.includes('Cannot connect to API') || m.includes('Timeout') || m.includes('(429)') || /\(5\d\d\)/.test(m)) return 'MODEL_UNAVAILABLE';
  return 'OTHER';
}

/** Short, safe text for the UI: drops anything after the first line and caps the length. */
export function safeMessage(message: string | undefined, fallback = 'unknown error'): string {
  const first = (message ?? '').split('\n')[0]!.trim();
  return (first || fallback).slice(0, 300);
}

/** True when an SDK/network exception means the TrueForge server itself could not be reached. */
export function isTrueForgeUnreachable(error: unknown): boolean {
  const text = `${(error as { message?: string })?.message ?? ''} ${String((error as { cause?: unknown })?.cause ?? '')}`;
  return /ECONNREFUSED|ECONNRESET|fetch failed|ENOTFOUND|EHOSTUNREACH|socket hang up/i.test(text);
}
