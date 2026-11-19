// Classifies turn.done(error) messages. Message formats verified against TrueForge 0.185.1 (spike/FINDINGS.md):
//   [Model Error] Request failed (401): <provider message>
//   [Model Error] Cannot connect to API: connect ECONNREFUSED 127.0.0.1:47799
//   [Model Error] Cannot connect to API: Connect Timeout Error (attempted address: ..., timeout: 3000ms)

// Providers word authentication failures differently (Google answers an invalid key with HTTP 400
// "API key not valid"), so the wording counts as well as the status code.
//   MODEL_AUTH → fallback at once · MODEL_UNAVAILABLE → retry once, then fallback
//   MODEL_OTHER (any other provider error) → fallback at once
//   OTHER (not a model error: TrueForge itself, iteration limit) → no fallback
export type TurnErrorClass = 'MODEL_AUTH' | 'MODEL_UNAVAILABLE' | 'MODEL_OTHER' | 'OTHER';

const AUTH_WORDING = /api[ _-]?key|unauthori[sz]ed|authenticat|permission[ _]denied|forbidden|credential/i;

export function classifyTurnError(message: string | undefined): TurnErrorClass {
  const m = message ?? '';
  if (!m.includes('[Model Error]')) return 'OTHER';
  if (/\((401|403)\)/.test(m) || AUTH_WORDING.test(m)) return 'MODEL_AUTH';
  if (m.includes('Cannot connect to API') || /timeout|timed out|overloaded|unavailable/i.test(m) || /\((408|429|5\d\d)\)/.test(m)) return 'MODEL_UNAVAILABLE';
  return 'MODEL_OTHER';
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

const SECRET_PATTERNS: RegExp[] = [
  /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}/g, // OpenAI, Anthropic (sk-ant-...)
  /\bAIza[0-9A-Za-z_-]{20,}/g, // Google
  /\bgsk_[A-Za-z0-9]{20,}/g, // Groq
  /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}/g, // GitHub
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
];
const SECRET_ASSIGNMENT = /(bearer\s+|(?:api[_-]?key|token|secret|password|passwd)["']?\s*[:=]\s*["']?)([^\s"',;]{6,})/gi;

/** Replaces key-shaped strings with [redacted]. For display and logs only, never for content under review. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[redacted]');
  return out.replace(SECRET_ASSIGNMENT, (_m, prefix: string) => `${prefix}[redacted]`);
}

/** Short, safe text for the UI: first line only, key-shaped strings redacted, length capped. */
export function safeMessage(message: string | undefined, fallback = 'unknown error'): string {
  const first = (message ?? '').split('\n')[0]!.trim();
  return redactSecrets(first || fallback).slice(0, 300);
}

/** True when an SDK/network exception means the TrueForge server itself could not be reached. */
export function isTrueForgeUnreachable(error: unknown): boolean {
  const text = `${(error as { message?: string })?.message ?? ''} ${String((error as { cause?: unknown })?.cause ?? '')}`;
  return /ECONNREFUSED|ECONNRESET|fetch failed|ENOTFOUND|EHOSTUNREACH|socket hang up/i.test(text);
}
