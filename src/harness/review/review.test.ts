import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeEdits,
  ApplyError,
  applyAccepted,
  canonicalArgsKey,
  canonicalJson,
  computeProposal,
  effectiveToolArgs,
  ReviewRegistry,
  type Proposal,
} from './index';

const FILE = ['def a():', '    return 1', '', 'def b():', '    return 2', '', 'def c():', '    return 3', ''].join('\n');

function ok(p: ReturnType<typeof computeProposal>): Proposal {
  if (!p.ok) assert.fail(`expected ok, got ${p.code}: ${p.message}`);
  return p;
}

test('exact match: single edit produces one hunk with line range and proposed text', () => {
  const p = ok(computeProposal(FILE, [{ old_text: '    return 2', new_text: '    return 20' }]));
  assert.equal(p.isNewFile, false);
  assert.equal(p.hunks.length, 1);
  assert.deepEqual(
    { start: p.hunks[0]!.startLine, end: p.hunks[0]!.endLine, index: p.hunks[0]!.index },
    { start: 5, end: 5, index: 0 },
  );
  assert.equal(p.proposedText, FILE.replace('return 2', 'return 20'));
});

test('multi-line old_text reports the covered line range', () => {
  const p = ok(computeProposal(FILE, [{ old_text: 'def b():\n    return 2\n', new_text: 'def b():\n    return 22\n' }]));
  assert.equal(p.hunks[0]!.startLine, 4);
  assert.equal(p.hunks[0]!.endLine, 5);
});

test('no match: OLD_TEXT_NOT_FOUND with the edit index', () => {
  const p = computeProposal(FILE, [
    { old_text: '    return 1', new_text: '    return 10' },
    { old_text: 'def zzz():', new_text: 'def y():' },
  ]);
  assert.equal(p.ok, false);
  if (!p.ok) {
    assert.equal(p.code, 'OLD_TEXT_NOT_FOUND');
    assert.equal(p.editIndex, 1);
  }
});

test('ambiguous match: OLD_TEXT_AMBIGUOUS', () => {
  const p = computeProposal(FILE, [{ old_text: 'def ', new_text: 'async def ' }]);
  assert.equal(p.ok, false);
  if (!p.ok) assert.equal(p.code, 'OLD_TEXT_AMBIGUOUS');
});

test('overlapping edits: OVERLAPPING_EDITS', () => {
  const p = computeProposal(FILE, [
    { old_text: 'def b():\n    return 2', new_text: 'def b():\n    return 3' },
    { old_text: '    return 2\n\ndef c', new_text: '    return 9\n\ndef c' },
  ]);
  assert.equal(p.ok, false);
  if (!p.ok) assert.equal(p.code, 'OVERLAPPING_EDITS');
});

test('adjacent edits are allowed', () => {
  const p = ok(computeProposal(FILE, [
    { old_text: 'def a():\n', new_text: 'def a1():\n' },
    { old_text: '    return 1\n', new_text: '    return 11\n' },
  ]));
  assert.equal(p.hunks.length, 2);
});

test('hunks come back in file order regardless of edit order', () => {
  const p = ok(computeProposal(FILE, [
    { old_text: '    return 3', new_text: '    return 30' },
    { old_text: '    return 1', new_text: '    return 10' },
  ]));
  assert.deepEqual(p.hunks.map((h) => [h.index, h.newText]), [[0, '    return 10'], [1, '    return 30']]);
});

test('invalid edits: empty array, empty old_text on existing file, no-op edit', () => {
  for (const edits of [[], [{ old_text: '', new_text: 'x' }], [{ old_text: 'def a', new_text: 'def a' }]]) {
    const p = computeProposal(FILE, edits);
    assert.equal(p.ok, false);
    if (!p.ok) assert.equal(p.code, 'INVALID_EDIT');
  }
});

test('new file: one edit with empty old_text', () => {
  const p = ok(computeProposal(null, [{ old_text: '', new_text: 'hello\n' }]));
  assert.equal(p.isNewFile, true);
  assert.equal(p.proposedText, 'hello\n');
  assert.equal(applyAccepted('', p.hunks, [0]).text, 'hello\n');
  const bad = computeProposal(null, [{ old_text: 'x', new_text: 'y' }]);
  assert.equal(bad.ok, false);
});

test('CRLF content: LF edits match and the result keeps CRLF', () => {
  const crlf = FILE.replace(/\n/g, '\r\n');
  const p = ok(computeProposal(crlf, [{ old_text: 'def b():\n    return 2', new_text: 'def b():\n    """Doc."""\n    return 2' }]));
  assert.equal(p.eol, '\r\n');
  assert.equal(p.hunks[0]!.startLine, 4);
  assert.equal(p.hunks[0]!.endLine, 5);
  assert.equal(p.proposedText, crlf.replace('def b():\r\n    return 2', 'def b():\r\n    """Doc."""\r\n    return 2'));
  assert.ok(!/[^\r]\n/.test(p.proposedText), 'no bare LF introduced');
});

test('partial accept applies only the accepted hunks', () => {
  const p = ok(computeProposal(FILE, [
    { old_text: '    return 1', new_text: '    return 10' },
    { old_text: '    return 2', new_text: '    return 20' },
    { old_text: '    return 3', new_text: '    return 30' },
  ]));
  const r = applyAccepted(FILE, p.hunks, [0, 2]);
  assert.deepEqual(r.applied, [0, 2]);
  assert.deepEqual(r.rejected, [1]);
  assert.equal(r.text, FILE.replace('return 1', 'return 10').replace('return 3', 'return 30'));
  assert.equal(applyAccepted(FILE, p.hunks, []).text, FILE);
});

test('applyAccepted rejects a stale base and unknown hunks', () => {
  const p = ok(computeProposal(FILE, [{ old_text: '    return 2', new_text: '    return 20' }]));
  assert.throws(() => applyAccepted(FILE.replace('return 2', 'return 7'), p.hunks, [0]), (e: unknown) => e instanceof ApplyError && e.code === 'STALE_BASE');
  assert.throws(() => applyAccepted(FILE, p.hunks, [5]), (e: unknown) => e instanceof ApplyError && e.code === 'UNKNOWN_HUNK');
});

test('canonicalArgsKey ignores key order and undefined, respects array order', () => {
  const a = { path: 'x.py', edits: [{ old_text: 'a', new_text: 'b' }], base_sha256: 's' };
  const b = { base_sha256: 's', edits: [{ new_text: 'b', old_text: 'a' }], path: 'x.py', summary: undefined };
  assert.equal(canonicalJson(a), canonicalJson(b));
  assert.equal(canonicalArgsKey(a), canonicalArgsKey(b));
  assert.match(canonicalArgsKey(a), /^[0-9a-f]{64}$/);
  const c = { ...a, edits: [{ old_text: 'a', new_text: 'b' }, { old_text: 'c', new_text: 'd' }] };
  const d = { ...a, edits: [{ old_text: 'c', new_text: 'd' }, { old_text: 'a', new_text: 'b' }] };
  assert.notEqual(canonicalArgsKey(c), canonicalArgsKey(d));
});

test('effectiveToolArgs unwraps the deferred call_tool input', () => {
  const inner = { name: 'get_debug_flag' };
  assert.deepEqual(effectiveToolArgs('call_tool', { mcp_server: 'vscode', tool_name: 'find_symbol', input: inner }), inner);
  assert.deepEqual(effectiveToolArgs('call_tool', { mcp_server: 'vscode', tool_name: 'list_files' }), {});
  assert.equal(effectiveToolArgs('propose_edit', inner), inner);
  assert.equal(
    canonicalArgsKey(effectiveToolArgs('call_tool', { mcp_server: 'vscode', tool_name: 'find_symbol', input: inner })),
    canonicalArgsKey(inner),
  );
});

test('ReviewRegistry: FIFO per key, each decision used once, clear drops all', () => {
  const r = new ReviewRegistry<string>();
  r.record('k1', 'first');
  r.record('k1', 'second');
  r.record('k2', 'other');
  assert.equal(r.size, 3);
  assert.equal(r.pending('k1'), 2);
  assert.equal(r.take('k1'), 'first');
  assert.equal(r.take('k1'), 'second');
  assert.equal(r.take('k1'), undefined);
  assert.equal(r.take('missing'), undefined);
  assert.equal(r.clear(), 1);
  assert.equal(r.take('k2'), undefined);
});

test('normalizeEdits: a JSON-encoded array string becomes the array; everything else is unchanged', () => {
  const arr = [{ old_text: 'a', new_text: 'b' }];
  assert.deepEqual(normalizeEdits(JSON.stringify(arr)), arr);
  assert.deepEqual(normalizeEdits(`  ${JSON.stringify(arr)}\n`), arr);
  assert.equal(normalizeEdits(arr), arr);
  assert.equal(normalizeEdits('[not json'), '[not json');
  assert.equal(normalizeEdits('{"old_text":"a"}'), '{"old_text":"a"}', 'only arrays');
  assert.equal(normalizeEdits(undefined), undefined);
  const p = computeProposal('x = 1\n', JSON.stringify([{ old_text: 'x = 1', new_text: 'x = 2' }]) as never);
  assert.ok(p.ok);
  const bad = computeProposal('x = 1\n', '[{"old_text": "x = 1", "new_text": ""\n}' as never);
  assert.equal(bad.ok, false);
  assert.match(!bad.ok ? bad.message : '', /not a string|Pass the array itself/);
});
