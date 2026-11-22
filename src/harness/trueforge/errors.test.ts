import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTurnError, isRateLimited, MAX_RESUME_HINT_MS, redactSecrets, retryAfterHintMs, retryDelayMs, safeMessage } from './errors';

test('classification of TrueForge turn errors (formats verified on 0.185.1)', () => {
  assert.equal(classifyTurnError('[Model Error] Request failed (401): Incorrect API key provided.'), 'MODEL_AUTH');
  assert.equal(classifyTurnError('[Model Error] Request failed (403): forbidden'), 'MODEL_AUTH');
  assert.equal(classifyTurnError('[Model Error] Cannot connect to API: connect ECONNREFUSED 127.0.0.1:47799'), 'MODEL_UNAVAILABLE');
  assert.equal(classifyTurnError('[Model Error] Cannot connect to API: Connect Timeout Error (attempted address: 10.255.255.1:80, timeout: 3000ms)'), 'MODEL_UNAVAILABLE');
  assert.equal(classifyTurnError('[Model Error] Request failed (429): Rate limit reached'), 'MODEL_UNAVAILABLE');
  assert.equal(classifyTurnError('[Model Error] Request failed (503): overloaded'), 'MODEL_UNAVAILABLE');
  assert.equal(classifyTurnError('[Model Error] Request failed (400): bad request'), 'MODEL_OTHER', 'other provider errors still fall back');
  assert.equal(classifyTurnError('iteration limit reached'), 'OTHER');
});

test('invalid-key errors observed with real providers (2026-11-19, TrueForge 0.185.1) fall back at once', () => {
  // NVIDIA (integrate.api.nvidia.com) answers an invalid key with 401 application/problem+json; TrueForge reports its title.
  assert.equal(classifyTurnError('[Model Error] Request failed (401): Unauthorized'), 'MODEL_AUTH');
  // Groq behind Cloudflare answered a direct client (not TrueForge) with 403 "error code: 1010": not retryable either.
  assert.equal(classifyTurnError('[Model Error] Request failed (403): error code: 1010'), 'MODEL_AUTH');
});

test('authentication failures are recognised by wording too (formats as documented by the providers; not observed here)', () => {
  // Google answers an invalid key with HTTP 400.
  assert.equal(classifyTurnError('[Model Error] Request failed (400): API key not valid. Please pass a valid API key.'), 'MODEL_AUTH');
  assert.equal(classifyTurnError('[Model Error] Request failed (400): {"error":{"code":400,"message":"API key not valid","status":"INVALID_ARGUMENT"}}'), 'MODEL_AUTH');
  assert.equal(classifyTurnError('[Model Error] Invalid API Key'), 'MODEL_AUTH');
  assert.equal(classifyTurnError('[Model Error] authentication_error: invalid x-api-key'), 'MODEL_AUTH');
  assert.equal(classifyTurnError('[Model Error] Unauthorized'), 'MODEL_AUTH');
  assert.equal(classifyTurnError('[Model Error] Request failed (503): Service Unavailable'), 'MODEL_UNAVAILABLE');
  assert.equal(classifyTurnError('[Model Error] The operation timed out'), 'MODEL_UNAVAILABLE');
  assert.equal(classifyTurnError('[Model Error] model does not support tools'), 'MODEL_OTHER');
});

test('displayed messages never carry key-shaped strings', () => {
  const m = safeMessage('[Model Error] Request failed (401): Incorrect API key provided: sk-proj-abcdefghijklmnop1234. api_key=hunter2hunter2');
  assert.doesNotMatch(m, /abcdefghijklmnop1234|hunter2hunter2/);
  assert.match(m, /\[redacted\]/);
  assert.equal(redactSecrets('key AIzaSyA1234567890abcdefghijklmnop and gsk_abcdefghijklmnopqrstuvwx'), 'key [redacted] and [redacted]');
  assert.equal(redactSecrets('Authorization: Bearer abcdef0123456789xyz'), 'Authorization: Bearer [redacted]');
  assert.equal(redactSecrets('plain text without secrets: 401'), 'plain text without secrets: 401');
});

test('rate-limit retry delay honours provider hints, defaults to 5 s and caps at 30 s', () => {
  assert.equal(isRateLimited('[Model Error] Request failed (429): x'), true);
  assert.equal(isRateLimited('[Model Error] Cannot connect to API'), false);
  assert.equal(retryDelayMs('[Model Error] Cannot connect to API', 2000), 2000, 'non-429 keeps the base delay');
  assert.equal(retryDelayMs('[Model Error] Request failed (429): Rate limit reached. Please try again in 12s.', 2000), 12000);
  assert.equal(retryDelayMs('[Model Error] Request failed (429): retry after 1.5 seconds', 2000), 2000, 'never shorter than the base delay');
  assert.equal(retryDelayMs('[Model Error] Request failed (429): Retry-After: 7', 2000), 7000);
  assert.equal(retryDelayMs('[Model Error] Request failed (429): please wait 4500ms', 2000), 4500);
  assert.equal(retryDelayMs('[Model Error] Request failed (429): Too many requests', 2000), 5000, 'default when no hint');
  assert.equal(retryDelayMs('[Model Error] Request failed (429): try again in 600s', 2000), 30000, 'capped');
});

test('Resume honours the provider wait hint beyond the 30 s retry cap, up to an hour', () => {
  assert.equal(retryAfterHintMs('[Model Error] Request failed (429): try again in 600s'), 600_000);
  assert.equal(retryAfterHintMs('[Model Error] Request failed (429): Retry-After: 120'), 120_000);
  assert.equal(retryAfterHintMs('[Model Error] Request failed (429): please wait 1.5 minutes'), 90_000);
  assert.equal(retryAfterHintMs('[Model Error] Request failed (429): retry in 2m'), 120_000);
  assert.equal(retryAfterHintMs('[Model Error] Request failed (429): please wait 4500ms'), 4500);
  assert.equal(retryAfterHintMs('[Model Error] Request failed (429): try again in 99999s'), MAX_RESUME_HINT_MS);
  assert.equal(retryAfterHintMs('[Model Error] Request failed (429): Too many requests'), undefined);
  assert.equal(retryAfterHintMs('[Model Error] Request failed (500): retry in 5s'), undefined, 'not a rate limit');
  assert.equal(retryDelayMs('[Model Error] Request failed (429): try again in 600s', 2000), 30000, 'the automatic retry stays capped');
});

test('an explicit transient status wins over auth-like wording; 401/403 and status-less auth wording still fall back at once', () => {
  assert.equal(classifyTurnError('[Model Error] Request failed (429): Rate limit exceeded for this API key. Add credits to continue.'), 'MODEL_UNAVAILABLE');
  assert.equal(classifyTurnError('[Model Error] Request failed (503): credential service temporarily unavailable'), 'MODEL_UNAVAILABLE');
  assert.equal(classifyTurnError('[Model Error] Request failed (408): authentication handshake timed out'), 'MODEL_UNAVAILABLE');
  assert.equal(classifyTurnError('[Model Error] Request failed (401): Unauthorized'), 'MODEL_AUTH', 'Task C');
  assert.equal(classifyTurnError('[Model Error] Request failed (403): rate limit on this key'), 'MODEL_AUTH');
  assert.equal(classifyTurnError('[Model Error] Request failed (400): API key not valid.'), 'MODEL_AUTH');
});
