import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TurnRun, type TurnDeps } from './turn';
import { ScopeRegistry } from '../mcp/scope';
import type { AttemptResult } from '../trueforge/attempt';
import type { EditorPort } from '../mcp/port';

for (const status of ['done', 'error', 'cancelled'] as const) {
  test(`unsettled tools hold ${status} turn open and suppress recovery`, async () => {
    const scopes = new ScopeRegistry();
    let release!: () => void;
    const pending = new Promise<void>(r => { release = r; });
    let sessions = 0;
    const deps = {
      scopes, workspaceRoot: '.', agentName: 'test', trueforgeUrl: 'http://localhost:8790',
      settleMs: 1, contextBudgetTokens: 8000, retryDelayMs: 0,
      runtimeSession: async () => { sessions++; return 'runtime'; }, agentModel: async () => 'model',
      port: { readText: async () => null, listFiles: async () => [], log: () => {} } as unknown as EditorPort,
    } as unknown as TurnDeps;
    const run = new TurnRun({ sessionId: 's', turnId: 't', mode: 'agent', instruction: 'test' }, deps);
    // Replace only the transport attempt: exercise the real settlement/recovery controller.
    Object.assign(run, { runAttempt: async (): Promise<AttemptResult> => {
      scopes.open('runtime').track(pending);
      return { status, message: '503 service unavailable', watchdog: false };
    } });
    const completion = run.start();
    for (let i = 0; i < 100 && !scopes.get('runtime')?.cancelled; i++) await new Promise(r => setTimeout(r, 2));
    assert.equal(scopes.get('runtime')?.cancelled, true);
    assert.equal(run.done, false, 'session must remain occupied');
    assert.equal(sessions, 1);
    assert.ok(run.buffer.snapshot().some(e => e.t === 'error' && e.error.workspaceEffect === 'unknown'));
    assert.ok(!run.buffer.snapshot().some(e => e.t === 'fallback'));
    release(); await completion;
    assert.equal(run.done, true); assert.equal(sessions, 1);
    assert.equal(run.buffer.snapshot().filter(e => e.t === 'done').length, 1);
  });
}
