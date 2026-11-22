import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => JSON.parse(readFileSync(path.join(root, 'src/harness/context', rel), 'utf8'));

test('corrected labels: every change names an original case, and every corrected Forge path exists', () => {
  const original = read('retrieval-benchmark.json');
  const corrected = read('retrieval-benchmark.corrected.json');
  assert.equal(corrected.base, 'retrieval-benchmark.json');
  for (const change of corrected.changes) {
    const c = original.cases.find((x) => x.id === change.id);
    assert.ok(c, `unknown case ${change.id}`);
    assert.ok(change.why, 'each correction says why');
    if (c.workspace === 'forge') for (const p of change.expectedPaths) assert.ok(existsSync(path.join(root, p)), `${p} exists`);
  }
  // The original labels stay as they were, so earlier figures remain comparable.
  assert.ok(original.cases.find((c) => c.id === 'forge-cancellation-settlement').expectedPaths.includes('src/harness/turn/settlement.ts'));
});

test('every original Forge gold path either exists or is corrected', () => {
  const original = read('retrieval-benchmark.json');
  const fixed = new Set(read('retrieval-benchmark.corrected.json').changes.map((c) => c.id));
  for (const c of original.cases.filter((x) => x.workspace === 'forge' && !fixed.has(x.id))) {
    for (const p of c.expectedPaths) assert.ok(existsSync(path.join(root, p)), `${c.id}: ${p}`);
  }
});
