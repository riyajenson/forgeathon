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

export const MAX_RETRY_DELAY_MS = 30_000;
export const RATE_LIMIT_DEFAULT_DELAY_MS = 5_000;

export function isRateLimited(message: string | undefined): boolean {
  return /\(429\)|rate.?limit|too many requests/i.test(message ?? '');
}

/**
 * Delay before the single retry. Rate-limit errors (429) honour a retry hint in the provider message
 * ("Retry-After: 12", "try again in 1.5s", "retry after 800ms"), else wait 5 s; capped at 30 s.
 */
export function retryDelayMs(message: string | undefined, baseMs: number): number {
  if (!isRateLimited(message)) return baseMs;
  const m = /(?:retry[- ]after|try again in|retry in|wait)\D{0,3}(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|sec|seconds?)?/i.exec(message ?? '');
  let ms = RATE_LIMIT_DEFAULT_DELAY_MS;
  if (m) ms = Number(m[1]) * (/^m(s|illi)/i.test(m[2] ?? '') ? 1 : 1000);
  return Math.min(MAX_RETRY_DELAY_MS, Math.max(baseMs, Math.ceil(ms)));
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
