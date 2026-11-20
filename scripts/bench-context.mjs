#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const scriptPath = fileURLToPath(import.meta.url);
const scriptRoot = path.resolve(path.dirname(scriptPath), '..');
const args = process.argv.slice(2);

function option(name, fallback) {
  const flag = `--${name}`;
  const index = args.findIndex((arg) => arg === flag || arg.startsWith(`${flag}=`));
  if (index < 0) return fallback;
  const entry = args[index];
  if (entry.includes('=')) return entry.slice(flag.length + 1);
  return args[index + 1] && !args[index + 1].startsWith('--') ? args[index + 1] : fallback;
}

const mode = option('mode', 'lexical');
if (mode !== 'lexical') {
  console.error(`Unsupported benchmark mode "${mode}". Task 1 supports --mode=lexical.`);
  process.exit(2);
}

const forgeRoot = path.resolve(option('root', process.env.FORGE_BENCH_ROOT ?? scriptRoot));
const datasetPath = path.join(forgeRoot, 'src/harness/context/retrieval-benchmark.json');
const dataset = JSON.parse(readFileSync(datasetPath, 'utf8'));
const requireFromScript = createRequire(import.meta.url);
const harnessDist = path.join(forgeRoot, 'src/harness/dist/src/harness');
const { FakePort } = requireFromScript(path.join(harnessDist, 'mcp/fake-port.js'));
const { buildIndex } = requireFromScript(path.join(harnessDist, 'context/workspace-index.js'));
const { assembleContext } = requireFromScript(path.join(harnessDist, 'context/engine.js'));
const { measureRetrieval } = requireFromScript(path.join(harnessDist, 'context/retrieval-benchmark.js'));

const benchmarkArtifacts = new Set([
  'src/harness/context/retrieval-benchmark.json',
  'src/harness/context/retrieval-benchmark.ts',
  'scripts/bench-context.mjs',
]);
const isBenchmarkArtifact = (file) => benchmarkArtifacts.has(file) || file.startsWith('docs/superpowers/') || file.startsWith('.superpowers/');

function benchmarkPort(root) {
  const source = new FakePort(root);
  return {
    listFiles: async (options) => {
      const files = await source.listFiles({ ...options, limit: 20000 });
      return files.filter((file) => !isBenchmarkArtifact(file)).slice(0, options?.limit ?? Infinity);
    },
    readText: (file) => source.readText(file),
    log: (level, message) => source.log(level, message),
    applyText: (request) => source.applyText(request),
  };
}

function workspaceRoot(name) {
  if (name === 'forge') return forgeRoot;
  if (name === 'flask') {
    return path.resolve(process.env.FORGE_FLASK_DIR ?? path.join(os.homedir(), 'projects', 'flask-3.1.3'));
  }
  throw new Error(`Unknown benchmark workspace: ${name}`);
}

const roots = new Map();
for (const benchmarkCase of dataset.cases) {
  const root = workspaceRoot(benchmarkCase.workspace);
  if (!existsSync(root)) continue;
  if (!roots.has(benchmarkCase.workspace)) roots.set(benchmarkCase.workspace, root);
}

const ports = new Map();
const indexes = new Map();
const indexTimings = {};
for (const [name, root] of roots) {
  const port = benchmarkPort(root);
  ports.set(name, port);

  let started = performance.now();
  const index = await buildIndex(port);
  const coldIndexMs = performance.now() - started;

  started = performance.now();
  await buildIndex(port);
  const warmIndexMs = performance.now() - started;

  indexes.set(name, index);
  indexTimings[name] = { root, files: index.files.size, chunks: index.chunks.length, coldIndexMs, warmIndexMs };
}

const results = [];
const unavailableCases = [];
for (const benchmarkCase of dataset.cases) {
  const port = ports.get(benchmarkCase.workspace);
  const index = indexes.get(benchmarkCase.workspace);
  if (!port || !index) {
    unavailableCases.push({ caseId: benchmarkCase.id, workspace: benchmarkCase.workspace, reason: 'workspace root is unavailable' });
    continue;
  }

  const started = performance.now();
  const context = await assembleContext(port, {
    instruction: benchmarkCase.query,
    mode: 'agent',
    budgetTokens: benchmarkCase.budgetTokens ?? 8000,
  }, index);
  const elapsedMs = performance.now() - started;
  results.push({
    caseId: benchmarkCase.id,
    expectedPaths: benchmarkCase.expectedPaths,
    rankedPaths: context.ranked.map((entry) => entry.path),
    packedPaths: context.report.selections.map((entry) => entry.path),
    packedTokens: context.report.estimatedTokens,
    elapsedMs,
  });
}

const metrics = measureRetrieval(results);
const output = {
  schemaVersion: 1,
  mode,
  generatedAt: new Date().toISOString(),
  node: process.version,
  dataset: path.relative(forgeRoot, datasetPath),
  caseCount: dataset.cases.length,
  scoredCaseCount: results.length,
  unavailableCases,
  index: indexTimings,
  tokenMetadata: {
    budgetTokens: 8000,
    estimate: 'Forge context token estimator',
    semanticModel: null,
  },
  excludedFromIndex: ['benchmark runner and dataset', 'docs/superpowers/**', '.superpowers/**'],
  metrics,
  results,
};

process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
