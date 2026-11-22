import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noMatchHint } from './proposal';

const FILE = 'import os\n\ndef load(path):\n    with open(path) as f:\n        return f.read()\n\ndef save(path, data):\n    pass\n';

test('noMatchHint: whitespace-insensitive match shows the exact current lines', () => {
  assert.equal(noMatchHint(FILE, 'def load(path):\n  with open(path) as f:\n    return f.read()\n'),
    'Closest match: lines 3-5 match old_text if whitespace is ignored; copy old_text exactly from the current text:\n3\tdef load(path):\n4\t    with open(path) as f:\n5\t        return f.read()');
});

test('noMatchHint: first line found once, the rest changed; shows the lines after it', () => {
  const h = noMatchHint(FILE, 'def save(path, data):\n    write(path, data)\n');
  assert.match(h, /^Closest match: old_text's first line is line 7, but the lines after it differ now\. Current text:\n7\tdef save\(path, data\):\n8\t    pass/);
});

test('noMatchHint: no candidate gives an empty hint; several first-line matches are listed', () => {
  assert.equal(noMatchHint(FILE, 'class Missing:\n    pass\n'), '');
  assert.equal(noMatchHint('x = 1\ny = 2\nx = 1\n', 'x = 1\nz = 3\n'), "old_text's first line occurs at lines 1, 3, but no complete match; read those lines again.");
});
