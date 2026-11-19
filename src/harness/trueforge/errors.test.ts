import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTurnError, isRateLimited, retryDelayMs } from './errors';

test('classification of TrueForge turn errors (formats verified on 0.185.1)', () => {
  assert.equal(classifyTurnError('[Model Error] Request failed (401): Incorrect API key provided.'), 'MODEL_AUTH');
  assert.equal(classifyTurnError('[Model Error] Request failed (403): forbidden'), 'MODEL_AUTH');
  assert.equal(classifyTurnError('[Model Error] Cannot connect to API: connect ECONNREFUSED 127.0.0.1:47799'), 'MODEL_UNAVAILABLE');
  assert.equal(classifyTurnError('[Model Error] Cannot connect to API: Connect Timeout Error (attempted address: 10.255.255.1:80, timeout: 3000ms)'), 'MODEL_UNAVAILABLE');
  assert.equal(classifyTurnError('[Model Error] Request failed (429): Rate limit reached'), 'MODEL_UNAVAILABLE');
  assert.equal(classifyTurnError('[Model Error] Request failed (503): overloaded'), 'MODEL_UNAVAILABLE');
  assert.equal(classifyTurnError('[Model Error] Request failed (400): bad request'), 'OTHER');
  assert.equal(classifyTurnError('iteration limit reached'), 'OTHER');
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
