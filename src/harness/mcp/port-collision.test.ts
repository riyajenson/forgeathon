import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { canonicalJson } from '../review/canonical';
import { createHarness } from '../index';

test('request fingerprints ignore property order but keep array order', () => {
  assert.equal(canonicalJson({ a: 1, b: { c: [1, 2], d: 'x' } }), canonicalJson({ b: { d: 'x', c: [1, 2] }, a: 1 }));
  assert.notEqual(canonicalJson({ c: [1, 2] }), canonicalJson({ c: [2, 1] }));
});

test('an occupied editor-tools port is reported with the setting that changes it', async () => {
  const blocker = net.createServer();
  await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', () => r()));
  const port = (blocker.address() as net.AddressInfo).port;
  // A stand-in TrueForge that answers models.list, so start() reaches the MCP listen.
  const tf = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [] })); });
  await new Promise<void>((r) => tf.listen(0, '127.0.0.1', () => r()));
  try {
    const h = createHarness({ trueforgeUrl: `http://127.0.0.1:${(tf.address() as net.AddressInfo).port}`, mcpPort: port });
    const bridge = { listFiles: async () => [], readText: async () => null, applyText: async () => { throw new Error('unused'); }, log: () => {} };
    await assert.rejects(h.start(bridge as never), (e: Error) => new RegExp(`127\\.0\\.0\\.1:${port} is in use.*"forge\\.mcpPort"`).test(e.message));
  } finally {
    blocker.close(); tf.close();
  }
});
