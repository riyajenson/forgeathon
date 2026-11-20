import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { existsSync, promises as fs } from 'node:fs';
import { FakePort } from '../mcp/fake-port';
import { chunkDocs, chunkPython } from './chunks';
import { GitIgnore, IgnorePolicy, visibleFiles } from './files';
import { assembleContext, buildIndex, parseMentions, rankFiles } from './index';
import { splitIdentifier, terms } from './text';
import type { EditorPort } from '../mcp/port';
import { INDEX_FILE_LIMIT } from './workspace-index';

function inventoryPort(count: number, broken = new Set<string>()): EditorPort {
  const files = Array.from({ length: count }, (_, i) => `src/file_${String(i).padStart(4, '0')}.py`);
  return {
    listFiles: async (options) => files.slice(0, options?.limit ?? 500),
    readText: async (file) => {
      if (broken.has(file)) throw new Error('permission denied');
      if (file === '.gitignore') return null;
      const text = `def symbol_${file.match(/\d+/)?.[0] ?? 'x'}():\n    return 1\n`;
      return { text, sha256: 'fixture' };
    },
    log: () => {}, applyText: async () => { throw new Error('not used'); },
  };
}

test('index requests inventory beyond the editor default 500 files', async () => {
  const index = await buildIndex(inventoryPort(601));
  assert.equal(index.files.size, 601);
  assert.ok(index.files.has('src/file_0600.py'));
  assert.ok(!index.skipped.some(s => s.path === '.'));
});

test('full inventory reports possible coverage loss in the visible context report', async () => {
  const result = await assembleContext(inventoryPort(INDEX_FILE_LIMIT + 1), { instruction: 'symbol_1999', mode: 'agent', budgetTokens: 8000 });
  assert.ok(result.report.skipped.some(s => s.path === '.' && /coverage may be incomplete/.test(s.reason)));
});

test('one unreadable file does not discard other code and is visible as skipped', async () => {
  const result = await assembleContext(inventoryPort(3, new Set(['src/file_0001.py'])), { instruction: 'symbol_0002', mode: 'agent', budgetTokens: 8000 });
  assert.ok(result.report.selections.some(s => s.path === 'src/file_0002.py'));
  assert.ok(result.report.skipped.some(s => s.path === 'src/file_0001.py' && /unreadable/.test(s.reason)));
});

test('unreadable ignore policy refuses indexing and explains why', async () => {
  const result = await assembleContext(inventoryPort(3, new Set(['.gitignore'])), { instruction: 'symbol', mode: 'agent', budgetTokens: 8000 });
  assert.equal(result.report.selections.length, 0);
  assert.ok(result.report.skipped.some(s => s.path === '.gitignore'));
});

test('unreadable root ignore rules hide files from search and listing inventory', async () => {
  const visible = await visibleFiles(inventoryPort(3, new Set(['.gitignore'])));
  assert.deepEqual(visible.files, []);
  assert.deepEqual(visible.unreadableIgnores, ['.gitignore']);
});

test('explicit references and selections never include credentials files', async () => {
  const fake = inventoryPort(1);
  const originalRead = fake.readText.bind(fake);
  fake.readText = async (file) => file === '.env'
    ? { text: 'SYNTHETIC_SECRET=fixture', sha256: 'fixture' }
    : originalRead(file);
  const result = await assembleContext(fake, {
    instruction: 'inspect @file:.env', mode: 'agent', budgetTokens: 8000,
    selection: { path: '.env', startLine: 1, endLine: 1, text: 'SYNTHETIC_SECRET=fixture' },
  });
  assert.ok(!result.text.includes('SYNTHETIC_SECRET'));
});

test('small configured budgets are not silently raised to 500 tokens', async () => {
  const result = await assembleContext(inventoryPort(3), { instruction: 'symbol_0002', mode: 'agent', budgetTokens: 10 });
  assert.equal(result.report.budgetTokens, 10);
  assert.ok(result.report.estimatedTokens <= 10);
});

const CLI = [
  'import click',
  'from .helpers import get_debug_flag',
  '',
  '',
  '@click.command("routes", short_help="Show the routes for the app.")',
  '@click.option("--sort", "-s")',
  'def routes_command(sort):',
  '    """Show all registered routes with endpoints and methods."""',
  '    click.echo(sort)',
  '',
  '',
  'class FlaskGroup(click.Group):',
  '    """Special group for Flask commands."""',
  '',
  '    def list_commands(self, ctx):',
  '        return ["routes", "run", "shell"]',
  '',
  '',
  'cli = FlaskGroup()',
  '',
].join('\n');

const HELPERS = 'import os\n\n\ndef get_debug_flag():\n    """Get whether debug mode should be enabled."""\n    return os.environ.get("FLASK_DEBUG")\n';
const TEST_CLI = 'from flask.cli import routes_command\n\n\ndef test_routes_command(runner):\n    result = runner.invoke(routes_command)\n    assert result.exit_code == 0\n';
const DOCS_CLI = 'Command Line Interface\n======================\n\nBuilt-in commands\n-----------------\n\nThe ``routes`` command shows routes. See :mod:`flask.cli` and ``routes_command``.\n';
const UNRELATED = 'def bake_bread(flour):\n    return flour * 2\n';

let root: string;
let port: FakePort;

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-ctx-'));
  const files: Record<string, string> = {
    'src/flask/cli.py': CLI,
    'src/flask/helpers.py': HELPERS,
    'tests/test_cli.py': TEST_CLI,
    'docs/cli.rst': DOCS_CLI,
    'src/kitchen/bread.py': UNRELATED,
    'build/generated.py': 'def routes_command():\n    pass\n',
    'secret/ignored.py': 'def routes_command():\n    pass\n',
    '.gitignore': 'secret/\n*.log\n',
    'app.log': 'routes command routes command',
  };
  for (const [rel, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), text);
  }
  port = new FakePort(root);
});

after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

test('identifiers split into searchable terms', () => {
  assert.deepEqual(splitIdentifier('getDebugFlag'), ['get', 'Debug', 'Flag']);
  assert.deepEqual(terms('routes_command FlaskGroup'), ['routes_command', 'route', 'command', 'flaskgroup', 'flask', 'group']);
});

test('python chunks: functions with decorators, classes up to their first method, methods, module code', () => {
  const chunks = chunkPython('src/flask/cli.py', CLI);
  const routes = chunks.find((c) => c.name === 'routes_command')!;
  assert.equal(routes.startLine, 5, 'starts at the first decorator');
  assert.equal(routes.endLine, 9);
  assert.equal(routes.decorators?.length, 2);
  const group = chunks.find((c) => c.name === 'FlaskGroup')!;
  assert.equal(group.endLine, 14, 'class chunk stops before its first method');
  assert.equal(chunks.find((c) => c.name === 'list_commands')!.qualname, 'FlaskGroup.list_commands');
  assert.ok(chunks.some((c) => c.kind === 'module' && c.text.includes('cli = FlaskGroup()')));
});

test('rst sections become chunks', () => {
  const chunks = chunkDocs('docs/cli.rst', DOCS_CLI);
  assert.deepEqual(chunks.map((c) => c.name), ['Command Line Interface', 'Built-in commands']);
});

test('gitignore matcher handles directories, globs and negation', () => {
  const gi = new GitIgnore('secret/\n*.log\n!keep.log\n/build\n');
  assert.equal(gi.ignores('secret/ignored.py'), true);
  assert.equal(gi.ignores('app.log'), true);
  assert.equal(gi.ignores('keep.log'), false);
  assert.equal(gi.ignores('build/x.py'), true);
  assert.equal(gi.ignores('src/build.py'), false);
});

test('gitignore semantics: ** patterns, anchoring, directory-only rules, ignored parents and nested files', () => {
  const gi = new GitIgnore('**/tmp/\ndocs/**/*.bak\n/only-root.txt\nlogs/\n!logs/keep.txt\n[Bb]in/\n\\#literal\n');
  assert.equal(gi.ignores('tmp/a.py'), true);
  assert.equal(gi.ignores('a/b/tmp/c.py'), true);
  assert.equal(gi.ignores('tmp.py'), false, 'tmp/ is directory-only');
  assert.equal(gi.ignores('docs/x.bak'), true);
  assert.equal(gi.ignores('docs/a/b/x.bak'), true);
  assert.equal(gi.ignores('only-root.txt'), true);
  assert.equal(gi.ignores('sub/only-root.txt'), false, 'a leading slash anchors');
  assert.equal(gi.ignores('logs/keep.txt'), true, 'a file inside an ignored directory cannot be re-included');
  assert.equal(gi.ignores('Bin/x'), true);
  assert.equal(gi.ignores('bin/x'), true);
  assert.equal(gi.ignores('#literal'), true);
  const nested = new IgnorePolicy(new Map([['', new GitIgnore('*.gen.py\n')], ['pkg', new GitIgnore('!keep.gen.py\nlocal/\n')]]));
  assert.equal(nested.ignores('a.gen.py'), true);
  assert.equal(nested.ignores('pkg/keep.gen.py'), false, 'a deeper .gitignore overrides a shallower one');
  assert.equal(nested.ignores('pkg/other.gen.py'), true);
  assert.equal(nested.ignores('pkg/local/x.py'), true);
  assert.equal(nested.ignores('local/x.py'), false, 'nested rules apply only below their directory');
  assert.equal(nested.ignores('.venv/lib/x.py'), true, 'default excludes');
  assert.equal(nested.ignores('src/mylib.egg-info/x.txt'), true);
});

test('index skips ignored, generated and non-text files; resolves imports', async () => {
  const index = await buildIndex(port);
  assert.ok(index.files.has('src/flask/cli.py'));
  assert.ok(!index.files.has('secret/ignored.py'), '.gitignore respected');
  assert.ok(!index.files.has('build/generated.py'), 'build output skipped');
  assert.ok(!index.files.has('app.log'), 'non-source files skipped');
  assert.deepEqual(index.files.get('src/flask/cli.py')!.imports, ['src/flask/helpers.py']);
  assert.equal(index.symbols.get('routes_command')?.[0]?.path, 'src/flask/cli.py');
});

test('ranking pairs the source file with its test and docs, with reasons', async () => {
  const index = await buildIndex(port);
  const { files } = rankFiles(index, 'Add a new built-in CLI command next to routes that lists commands');
  const order = files.map((f) => f.path);
  assert.ok(order.indexOf('src/flask/cli.py') < 2, `source file in the top 2: ${order.join(', ')}`);
  for (const p of ['tests/test_cli.py', 'docs/cli.rst']) assert.ok(order.indexOf(p) >= 0 && order.indexOf(p) < 4, `${p} ranked near the top: ${order.join(', ')}`);
  assert.ok(!order.includes('src/kitchen/bread.py'));
  const test = files.find((f) => f.path === 'tests/test_cli.py')!;
  assert.ok(test.reasons.includes('tests for src/flask/cli.py'));
  const docs = files.find((f) => f.path === 'docs/cli.rst')!;
  assert.ok(docs.reasons.some((r) => r.startsWith('documents src/flask/cli.py')));
});

test('assembleContext respects the budget, pins selection and mentions, and reports skipped items', async () => {
  const r = await assembleContext(port, {
    instruction: 'Add a command like @symbol:routes_command and check @file:src/flask/helpers.py and @symbol:missing_thing',
    selection: { path: 'src/flask/cli.py', startLine: 15, endLine: 16, text: '    def list_commands(self, ctx):\n        return ["routes", "run", "shell"]' },
    budgetTokens: 600,
    mode: 'agent',
  });
  const sel = r.report.selections;
  assert.equal(sel[0]!.source, 'selection');
  assert.ok(sel.some((s) => s.source === 'explicit' && s.symbol === 'routes_command'));
  assert.ok(sel.some((s) => s.source === 'explicit' && s.path === 'src/flask/helpers.py'));
  assert.ok(r.report.skipped.some((s) => s.path === '@symbol:missing_thing'));
  assert.ok(r.report.estimatedTokens <= r.report.budgetTokens);
  assert.equal(sel.reduce((s, x) => s + x.estimatedTokens, 0), r.report.estimatedTokens);
  sel.forEach((s, i) => assert.equal(s.rank, i + 1));
  assert.match(r.text, /### src\/flask\/cli\.py lines 15-16 \(selection\)/);

  const tiny = await assembleContext(port, { instruction: 'routes command cli test docs', budgetTokens: 500, mode: 'agent' });
  assert.ok(tiny.report.estimatedTokens <= 500);
  assert.ok(tiny.report.selections.every((s) => s.rationale.length > 0));
});

const FLASK = process.env['FORGE_FLASK_DIR'] ?? path.join(os.homedir(), 'projects', 'flask-3.1.3');
const haveFlask = existsSync(path.join(FLASK, 'src', 'flask', 'cli.py'));

test('Flask 3.1.3: the file to change ranks first, with its test and docs packed', { skip: !haveFlask && 'Flask checkout not found' }, async () => {
  const flask = new FakePort(FLASK);
  const index = await buildIndex(flask);
  const cases: Array<[string, string]> = [
    ['Add a new built-in CLI command flask config that prints the loaded application\'s configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.', 'src/flask/cli.py'],
    ['Make url_for support an _anchor argument that is URL-quoted', 'src/flask/helpers.py'],
    ['The session cookie should honour SESSION_COOKIE_PARTITIONED', 'src/flask/sessions.py'],
    ['Add a send_file option to set the Content-Disposition filename', 'src/flask/helpers.py'],
    ['Blueprint registration should reject a name containing a dot', 'src/flask/sansio/blueprints.py'],
  ];
  for (const [task, expected] of cases) {
    assert.equal(rankFiles(index, task).files[0]?.path, expected, task);
  }
  const r = await assembleContext(flask, { instruction: cases[0]![0], budgetTokens: 8000, mode: 'agent' }, index);
  const packed = new Set(r.report.selections.map((s) => s.path));
  for (const p of ['src/flask/cli.py', 'tests/test_cli.py', 'docs/cli.rst']) assert.ok(packed.has(p), `${p} packed`);
  assert.ok(r.report.estimatedTokens <= 8000);
  assert.ok(r.report.skipped.length > 0, 'budget cut-offs are reported');
});

test('parseMentions', () => {
  assert.deepEqual(parseMentions('fix @file:src/a.py, then @symbol:Foo.bar.'), [{ kind: 'file', path: 'src/a.py' }, { kind: 'symbol', name: 'Foo.bar' }]);
});

test('indexing yields to the event loop and reuses unchanged files', async () => {
  const files = Array.from({ length: 400 }, (_, i) => `pkg/mod_${i}.py`);
  const text = (i: number, v = 0) => Array.from({ length: 40 }, (_, j) => `def handler_${i}_${j}_${v}(request):\n    return compute_value(request, ${j})\n`).join('\n');
  const contents = new Map(files.map((f, i) => [f, text(i)]));
  let reads = 0;
  const port: EditorPort = {
    listFiles: async () => files,
    readText: async (file) => {
      reads++;
      const t = contents.get(file);
      return t === undefined ? null : { text: t, sha256: createHash('sha256').update(t).digest('hex') };
    },
    log: () => {}, applyText: async () => { throw new Error('not used'); },
  };
  let ticks = 0;
  const tick = setInterval(() => { ticks++; }, 1);
  const first = await buildIndex(port);
  clearInterval(tick);
  assert.equal(first.files.size, 400);
  assert.ok(ticks >= 2, `the event loop ran during indexing (${ticks} ticks)`);
  contents.set('pkg/mod_7.py', text(7, 1));
  const second = await buildIndex(port);
  assert.ok(second.symbols.has('handler_7_0_1') && !second.symbols.has('handler_7_0_0'), 'a changed file is re-analysed');
  assert.deepEqual([...second.chunks.map((c) => c.id)], second.chunks.map((_, i) => i), 'chunk ids are dense and fresh per build');
  assert.equal(second.chunks.length, first.chunks.length);
  assert.ok(reads >= 800);
});

test('retrieval benchmark reports recall, reciprocal rank, packed file density, and median latency', () => {
  let benchmark: { measureRetrieval?: (results: unknown[]) => unknown } | undefined;
  try { benchmark = require('./retrieval-benchmark') as typeof benchmark; } catch { /* New module is the behavior under test. */ }
  assert.equal(typeof benchmark?.measureRetrieval, 'function', 'benchmark metric function is exported');
  assert.deepEqual(benchmark!.measureRetrieval!([
    { caseId: 'first', expectedPaths: ['src/a.ts', 'src/b.ts'], rankedPaths: ['src/x.ts', 'src/a.ts', 'src/b.ts'], packedPaths: ['src/a.ts'], packedTokens: 500, elapsedMs: 10 },
    { caseId: 'second', expectedPaths: ['src/c.ts'], rankedPaths: ['src/c.ts'], packedPaths: ['src/c.ts'], packedTokens: 250, elapsedMs: 30 },
  ]), {
    recallAt5: 1,
    mrr: 0.75,
    relevantFilesPer1000Tokens: 2000 / 750,
    medianElapsedMs: 20,
  });
});

type SemanticTestChunk = {
  path: string;
  startLine: number;
  endLine: number;
  text: string;
  sha256: string;
  semanticVectors: Map<string, number[]>;
};
type SemanticTestWorker = {
  embed: (texts: readonly string[], signal?: AbortSignal, progress?: (event: { status: string; progress?: number }) => void) => Promise<readonly number[][]>;
  dispose: () => Promise<void>;
};
type SemanticTestApi = {
  semanticChunkId: (chunk: Pick<SemanticTestChunk, 'path' | 'startLine' | 'endLine'>) => string;
  LocalSemanticRanker: new (options?: {
    workerFactory?: () => SemanticTestWorker;
    onProgress?: (event: { status: string; progress?: number }) => void;
  }) => {
    rank: (query: string, chunks: readonly SemanticTestChunk[], signal?: AbortSignal) => Promise<ReadonlyMap<string, number>>;
    dispose: () => Promise<void>;
  };
};
function semanticApiForTest(): SemanticTestApi | undefined {
  try { return require('./semantic') as SemanticTestApi; } catch { return undefined; }
}

test('semantic chunk IDs are stable for a path and line range', () => {
  const api = semanticApiForTest();
  assert.ok(api, 'semantic module is present');
  assert.equal(api.semanticChunkId({ path: 'src/alpha.py', startLine: 4, endLine: 9 }), 'src/alpha.py:4:9');
  assert.notEqual(api.semanticChunkId({ path: 'src/alpha.py', startLine: 4, endLine: 10 }), 'src/alpha.py:4:9');
});

test('semantic vectors reuse unchanged file analysis and invalidate after a content hash change', async () => {
  const api = semanticApiForTest();
  assert.ok(api, 'semantic module is present');
  const localRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-semantic-cache-'));
  const localPath = path.join(localRoot, 'src', 'sample.py');
  await fs.mkdir(path.dirname(localPath), { recursive: true });
  await fs.writeFile(localPath, 'def handler():\n    return 1\n');
  const localPort = new FakePort(localRoot);
  const batches: number[] = [];
  const ranker = new api.LocalSemanticRanker({
    workerFactory: () => ({
      embed: async (texts) => { batches.push(texts.length); return texts.map(() => [1, 0]); },
      dispose: async () => {},
    }),
  });
  try {
    const first = await buildIndex(localPort);
    const firstChunks = first.chunks.filter((chunk) => chunk.path === 'src/sample.py') as unknown as SemanticTestChunk[];
    await ranker.rank('handler', firstChunks);

    const unchanged = await buildIndex(localPort);
    const unchangedChunks = unchanged.chunks.filter((chunk) => chunk.path === 'src/sample.py') as unknown as SemanticTestChunk[];
    assert.strictEqual(unchangedChunks[0]!.semanticVectors, firstChunks[0]!.semanticVectors);
    await ranker.rank('handler', unchangedChunks);
    assert.deepEqual(batches, [firstChunks.length + 1, 1], 'unchanged chunks reuse their cached vectors');

    await fs.writeFile(localPath, 'def handler():\n    return 2\n');
    const changed = await buildIndex(localPort);
    const changedChunks = changed.chunks.filter((chunk) => chunk.path === 'src/sample.py') as unknown as SemanticTestChunk[];
    assert.notStrictEqual(changedChunks[0]!.semanticVectors, firstChunks[0]!.semanticVectors);
    assert.equal(changedChunks[0]!.semanticVectors.size, 0, 'a new SHA-256 starts with an empty vector cache');
    await ranker.rank('handler', changedChunks);
    assert.deepEqual(batches, [firstChunks.length + 1, 1, changedChunks.length + 1]);
  } finally {
    await ranker.dispose();
    await fs.rm(localRoot, { recursive: true, force: true });
  }
});

test('missing semantic model falls back to no semantic scores and reports download progress', async () => {
  const api = semanticApiForTest();
  assert.ok(api, 'semantic module is present');
  const chunk = (await buildIndex(port).then((index) => index.chunks.slice(0, 1))) as unknown as SemanticTestChunk[];
  const progress: Array<{ status: string; progress?: number }> = [];
  const ranker = new api.LocalSemanticRanker({
    onProgress: (event) => progress.push(event),
    workerFactory: () => ({
      embed: async (_texts, _signal, onProgress) => {
        onProgress?.({ status: 'progress_total', progress: 42 });
        throw new Error('model files unavailable');
      },
      dispose: async () => {},
    }),
  });
  try {
    assert.deepEqual([...await ranker.rank('find handler', chunk)], []);
    assert.deepEqual(progress, [{ status: 'progress_total', progress: 42 }]);
  } finally {
    await ranker.dispose();
  }
});

test('cancelled semantic work returns no stale scores or cached vectors', async () => {
  const api = semanticApiForTest();
  assert.ok(api, 'semantic module is present');
  const chunk = (await buildIndex(port).then((index) => index.chunks.slice(0, 1))) as unknown as SemanticTestChunk[];
  const controller = new AbortController();
  let disposed = false;
  const ranker = new api.LocalSemanticRanker({
    workerFactory: () => ({
      embed: (_texts, signal) => new Promise((_resolve, reject) => {
        const cancel = () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
        if (signal?.aborted) cancel();
        else signal?.addEventListener('abort', cancel, { once: true });
      }),
      dispose: async () => { disposed = true; },
    }),
  });
  try {
    const pending = ranker.rank('find handler', chunk, controller.signal);
    controller.abort();
    assert.deepEqual([...await pending], []);
    assert.equal(chunk[0]!.semanticVectors.size, 0);
  } finally {
    await ranker.dispose();
  }
  assert.ok(disposed, 'dispose releases the worker');
});

type HybridChunk = { path: string; startLine: number; endLine: number; text: string };
type HybridRankedFile = { path: string; score: number; reasons: string[]; chunks: Array<{ chunk: HybridChunk; score: number; matched: string[] }> };
type HybridRankApi = {
  rankFiles: (index: Awaited<ReturnType<typeof buildIndex>>, task: string, semanticRanks?: ReadonlyMap<string, number>) => { files: HybridRankedFile[]; queryTerms: string[] };
  shouldUseSemantic: (files: readonly HybridRankedFile[], queryTerms: readonly string[]) => boolean;
};

function hybridRankApiForTest(): HybridRankApi | undefined {
  try { return require('./rank') as HybridRankApi; } catch { return undefined; }
}

test('hybrid rank fusion adds semantic-only files and leaves omitted semantic results lexical-only', async () => {
  const api = hybridRankApiForTest();
  assert.ok(api, 'hybrid ranking helpers are exported');
  const index = await buildIndex(port);
  const task = 'route command';
  const lexical = rankFiles(index, task).files;
  const legacyShape = api.rankFiles(index, task).files;
  assert.deepEqual(legacyShape.map((file) => file.path), lexical.map((file) => file.path));

  const target = index.files.get('src/kitchen/bread.py')!.chunks[0]!;
  const semantic = new Map([[`${target.path}:${target.startLine}:${target.endLine}`, 0.99]]);
  const hybrid = api.rankFiles(index, 'find a constellation', semantic).files;
  assert.equal(hybrid[0]?.path, 'src/kitchen/bread.py', 'semantic evidence can surface a file absent from lexical results');
  assert.ok(hybrid[0]?.reasons.some((reason) => /semantic/i.test(reason)));
});

test('semantic activation uses term coverage and score margin, and ignores empty queries', async () => {
  const api = hybridRankApiForTest();
  assert.ok(api, 'hybrid ranking helpers are exported');
  const makeFile = (path: string, score: number, matched: string[]): HybridRankedFile => ({
    path, score, reasons: [], chunks: [{ chunk: { path, startLine: 1, endLine: 2, text: '' }, score, matched }],
  });
  assert.equal(api.shouldUseSemantic([], ['missing']), true, 'no lexical result is weak evidence');
  assert.equal(api.shouldUseSemantic([makeFile('src/a.py', 10, ['auth', 'token', 'session', 'cookie']), makeFile('src/b.py', 8.5, ['auth'])], ['auth', 'token', 'session', 'cookie', 'login']), false, 'broad coverage and a clear margin stay lexical');
  assert.equal(api.shouldUseSemantic([makeFile('src/a.py', 10, ['auth']), makeFile('src/b.py', 9.8, ['auth'])], ['auth', 'token', 'session', 'cookie']), true, 'low coverage activates semantic reranking');
  assert.equal(api.shouldUseSemantic([makeFile('src/a.py', 10, ['auth', 'token', 'session', 'cookie']), makeFile('src/b.py', 9.8, ['auth'])], ['auth', 'token', 'session', 'cookie']), true, 'a narrow top-two score margin activates reranking');
  assert.equal(api.shouldUseSemantic([], []), false, 'an empty query has no semantic signal');
});

test('semantic rank ties are deterministic and empty queries do not produce semantic results', async () => {
  const api = hybridRankApiForTest();
  assert.ok(api, 'hybrid ranking helpers are exported');
  const index = await buildIndex(port);
  const chunks = ['src/kitchen/bread.py', 'src/flask/helpers.py'].map((file) => index.files.get(file)!.chunks[0]!);
  const semantic = new Map(chunks.map((chunk) => [`${chunk.path}:${chunk.startLine}:${chunk.endLine}`, 0.75]));
  const first = api.rankFiles(index, 'unmatched constellation', semantic).files.map((file) => file.path);
  const second = api.rankFiles(index, 'unmatched constellation', semantic).files.map((file) => file.path);
  assert.deepEqual(first, second);
  assert.deepEqual(first.slice(0, 2), ['src/flask/helpers.py', 'src/kitchen/bread.py'], 'equal evidence breaks ties by path');
  assert.deepEqual(api.rankFiles(index, '', semantic).files, [], 'empty queries stay deterministic and do not use arbitrary vectors');
});

type HybridEngineApi = {
  assembleContext: (
    port: EditorPort,
    request: { instruction: string; budgetTokens: number; mode: 'inline' | 'agent'; references?: readonly { kind: 'file' | 'symbol'; path?: string; name?: string }[]; semanticSearch?: boolean },
    prebuilt?: Awaited<ReturnType<typeof buildIndex>>,
    options?: { semanticRanker?: { rank: (query: string, chunks: readonly HybridChunk[], signal?: AbortSignal) => Promise<ReadonlyMap<string, number>> } },
  ) => Promise<{ ranked: HybridRankedFile[]; report: { estimatedTokens: number; budgetTokens: number; selections: Array<{ path: string; source: string; rationale: string; range?: { startLine: number; endLine: number } }> } }>;
};

test('hybrid context keeps explicit references first and stays within its token budget', async () => {
  let engine: HybridEngineApi | undefined;
  try { engine = require('./engine') as HybridEngineApi; } catch { engine = undefined; }
  assert.ok(engine, 'context assembly exposes semantic ranking options');
  const index = await buildIndex(port);
  let seenCandidates: string[] = [];
  const result = await engine.assembleContext(port, {
    instruction: 'mystery account login transaction permission orchestrator routes command',
    references: [{ kind: 'file', path: 'src/flask/cli.py' }],
    budgetTokens: 500,
    mode: 'agent',
    semanticSearch: true,
  }, index, {
    semanticRanker: {
      rank: async (_query, chunks) => {
        seenCandidates = chunks.map((chunk) => chunk.path);
        return new Map(chunks.filter((chunk) => chunk.path === 'src/flask/helpers.py').map((chunk) => [`${chunk.path}:${chunk.startLine}:${chunk.endLine}`, 0.99]));
      },
    },
  });
  assert.ok(seenCandidates.includes('src/flask/helpers.py'), 'structural neighbors are included in the bounded semantic candidate set');
  assert.equal(result.report.selections[0]?.path, 'src/flask/cli.py');
  assert.equal(result.report.selections[0]?.source, 'explicit');
  assert.ok(result.report.estimatedTokens <= result.report.budgetTokens);
});

test('semantic search on without its runtime: lexical ranking, and the context report says why', async () => {
  const engine = require('./engine') as HybridEngineApi;
  const { SEMANTIC_RUNTIME_MISSING } = require('./semantic-runtime') as typeof import('./semantic-runtime');
  const index = await buildIndex(port);
  const ranker = { unavailable: undefined as Error | undefined, rank: async () => { ranker.unavailable = new Error(`${SEMANTIC_RUNTIME_MISSING} (looked in /x)`); return new Map<string, number>(); } };
  const request = { instruction: 'mystery account login transaction permission orchestrator routes command', budgetTokens: 2000, mode: 'agent' as const, semanticSearch: true };
  const result = await engine.assembleContext(port, request, index, { semanticRanker: ranker }) as Awaited<ReturnType<HybridEngineApi['assembleContext']>> & { report: { skipped: Array<{ path: string; reason: string }> } };
  assert.deepEqual(result.report.skipped.filter((s) => s.path === '(semantic search)').map((s) => s.reason), [SEMANTIC_RUNTIME_MISSING]);
  const lexical = await engine.assembleContext(port, { ...request, semanticSearch: false }, index) as typeof result;
  assert.deepEqual(result.report.selections.map((s) => s.path), lexical.report.selections.map((s) => s.path), 'same selections as lexical-only');
  assert.equal(lexical.report.skipped.some((s) => s.path === '(semantic search)'), false, 'off by default: nothing reported');
});

test('the semantic runtime is found in src/harness/semantic-runtime, or where FORGE_SEMANTIC_RUNTIME points', () => {
  const { semanticRuntimeDir } = require('./semantic-runtime') as typeof import('./semantic-runtime');
  assert.match(semanticRuntimeDir({}), /src[\\/]harness[\\/]semantic-runtime$/);
  assert.equal(semanticRuntimeDir({ FORGE_SEMANTIC_RUNTIME: '/opt/forge-sem' }), path.resolve('/opt/forge-sem'));
});

test('hybrid context packs overlapping chunks at most once', async () => {
  let engine: HybridEngineApi | undefined;
  try { engine = require('./engine') as HybridEngineApi; } catch { engine = undefined; }
  assert.ok(engine, 'context assembly exposes semantic ranking options');
  const index = await buildIndex(port);
  const file = index.files.get('src/flask/cli.py')!;
  const source = file.chunks.find((chunk) => chunk.name === 'routes_command')!;
  const overlapping = { ...source, id: index.chunks.length, startLine: source.startLine + 1 };
  file.chunks.push(overlapping);
  index.chunks.push(overlapping);

  const result = await engine.assembleContext(port, {
    instruction: 'new account permission path workflow routes command',
    budgetTokens: 1000,
    mode: 'inline',
    semanticSearch: true,
  }, index, {
    semanticRanker: {
      rank: async (_query, chunks) => new Map(chunks
        .filter((chunk) => chunk.path === 'src/flask/cli.py')
        .map((chunk) => [`${chunk.path}:${chunk.startLine}:${chunk.endLine}`, 0.95])),
    },
  });
  const selected = result.report.selections.filter((selection) => selection.path === 'src/flask/cli.py' && selection.range);
  for (let i = 0; i < selected.length; i++) {
    for (let j = i + 1; j < selected.length; j++) {
      const left = selected[i]!.range!;
      const right = selected[j]!.range!;
      assert.ok(left.endLine < right.startLine || right.endLine < left.startLine, 'selected ranges do not overlap');
    }
  }
});

test('hybrid packing prefers more relevant code per estimated token after pinned context', async () => {
  let engine: HybridEngineApi | undefined;
  try { engine = require('./engine') as HybridEngineApi; } catch { engine = undefined; }
  assert.ok(engine, 'context assembly exposes semantic ranking options');
  const localRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-context-density-'));
  const longBody = Array.from({ length: 18 }, () => '    result = alpha + beta + gamma + delta').join('\n');
  await fs.mkdir(path.join(localRoot, 'src'), { recursive: true });
  await fs.writeFile(path.join(localRoot, 'src', 'large.py'), `def execute_batch():\n${longBody}\n    return result\n`);
  await fs.writeFile(path.join(localRoot, 'src', 'short.py'), 'def execute_one():\n    return alpha\n');
  const localPort = new FakePort(localRoot);
  try {
    const index = await buildIndex(localPort);
    const result = await engine.assembleContext(localPort, {
      instruction: 'alpha beta gamma delta omega sigma theta lambda epsilon zeta kappa iota',
      budgetTokens: 1000,
      mode: 'inline',
      semanticSearch: true,
    }, index, {
      semanticRanker: {
        rank: async (_query, chunks) => new Map(chunks.map((chunk) => [`${chunk.path}:${chunk.startLine}:${chunk.endLine}`, 0.9])),
      },
    });
    const automatic = result.report.selections.filter((selection) => selection.source === 'automatic');
    assert.equal(automatic[0]?.path, 'src/short.py', 'the shorter relevant chunk gives more retrieval value per token');
    assert.ok(result.report.estimatedTokens <= result.report.budgetTokens);
  } finally {
    await fs.rm(localRoot, { recursive: true, force: true });
  }
});
