import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deletedDefinitions } from './deletions';

const SRC = [
  'import click',
  '',
  '',
  'class TestRoutes:',
  '    @pytest.fixture',
  '    def app(self):',
  '        return Flask(__name__)',
  '',
  '    def test_simple(self, runner):',
  '        assert runner',
  '',
  '',
  'def test_load_dotenv():',
  '    pass',
  '',
].join('\n');
const range = (from: string, to: string) => ({ startOffset: SRC.indexOf(from), endOffset: SRC.indexOf(to) + to.length });

test('a hunk that removes a whole class reports the class (not its methods) with its line count', () => {
  const r = range('class TestRoutes:', '        assert runner');
  assert.deepEqual(deletedDefinitions(SRC, { ...r, newText: 'class TestConfig:\n    pass' }), [{ kind: 'class', name: 'TestRoutes', lines: 7 }]);
});

test('methods removed while the class header stays are reported one by one, decorators included', () => {
  const r = range('    @pytest.fixture', '        assert runner');
  assert.deepEqual(deletedDefinitions(SRC, { ...r, newText: '    pass' }), [
    { kind: 'function', name: 'app', lines: 3 },
    { kind: 'function', name: 'test_simple', lines: 2 },
  ]);
});

test('a definition that is rewritten under the same name, or only partly inside the hunk, is not reported', () => {
  const whole = range('def test_load_dotenv():', '    pass');
  assert.deepEqual(deletedDefinitions(SRC, { ...whole, newText: 'def test_load_dotenv():\n    assert True' }), []);
  const part = range('class TestRoutes:', '        return Flask(__name__)');
  assert.deepEqual(deletedDefinitions(SRC, { ...part, newText: '' }), [{ kind: 'function', name: 'app', lines: 3 }],
    'the class body continues past the hunk, so only the method inside it is reported');
  const insertion = { startOffset: SRC.indexOf('def test_load_dotenv'), endOffset: SRC.indexOf('def test_load_dotenv'), newText: 'def new():\n    pass\n\n\n' };
  assert.deepEqual(deletedDefinitions(SRC, insertion), []);
});

test('async functions count as functions', () => {
  const src = 'async def fetch():\n    return 1\n';
  assert.deepEqual(deletedDefinitions(src, { startOffset: 0, endOffset: src.length, newText: '' }), [{ kind: 'function', name: 'fetch', lines: 2 }]);
});
