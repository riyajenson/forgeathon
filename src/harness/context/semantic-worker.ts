import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import type { SemanticProgress } from './semantic';
import { SEMANTIC_RUNTIME_MISSING } from './semantic-runtime';

interface EmbedMessage { type: 'embed'; id: number; texts: string[] }
interface CancelMessage { type: 'cancel'; id: number }
type WorkerRequest = EmbedMessage | CancelMessage;

const modelId = typeof workerData?.modelId === 'string' ? workerData.modelId : 'onnx-community/all-MiniLM-L6-v2-ONNX';
const revision = typeof workerData?.revision === 'string' ? workerData.revision : '2a90286a00a3fba4a0c16c5ea113091359ad5c86';
const cacheDir = typeof workerData?.cacheDir === 'string' ? workerData.cacheDir : path.join(os.homedir(), '.cache', 'forgeathon', 'transformers');
const runtimeDir = typeof workerData?.runtimeDir === 'string' ? workerData.runtimeDir : '';
const cancelled = new Set<number>();
let activeRequestId: number | undefined;
let extractorPromise: ReturnType<typeof createExtractor> | undefined;
let queue = Promise.resolve();

async function createExtractor() {
  const { env, pipeline } = loadTransformers();
  await fs.mkdir(cacheDir, { recursive: true });
  env.cacheDir = cacheDir;
  return pipeline('feature-extraction', modelId, {
    device: 'cpu',
    dtype: 'q4',
    revision,
    cache_dir: cacheDir,
    progress_callback: (event) => {
      const id = activeRequestId;
      if (id !== undefined && !cancelled.has(id)) {
        parentPort?.postMessage({ type: 'progress', id, event: event as SemanticProgress });
      }
    },
  });
}

/** The subset of @huggingface/transformers this worker uses (the package is optional and has no types here). */
interface Transformers {
  env: { cacheDir: string };
  pipeline(task: 'feature-extraction', model: string, options: Record<string, unknown> & { progress_callback?: (event: unknown) => void }):
    Promise<(texts: string[], options: { pooling: 'mean'; normalize: boolean }) => Promise<{ dims: number[]; data: unknown }>>;
}

/** Loads the opt-in runtime (scripts/enable-semantic-search.sh); never a dependency of the harness itself. */
function loadTransformers(): Transformers {
  const req = createRequire(path.join(runtimeDir || process.cwd(), 'package.json'));
  let entry: string;
  try { entry = req.resolve('@huggingface/transformers'); }
  catch { throw new Error(`${SEMANTIC_RUNTIME_MISSING} (looked in ${runtimeDir || process.cwd()})`); }
  return req(entry) as Transformers;
}

async function getExtractor(requestId: number) {
  if (!extractorPromise) {
    activeRequestId = requestId;
    extractorPromise = createExtractor();
  }
  try {
    return await extractorPromise;
  } catch (error) {
    extractorPromise = undefined;
    throw error;
  }
}

async function embed(message: EmbedMessage): Promise<void> {
  activeRequestId = message.id;
  try {
    const extractor = await getExtractor(message.id);
    if (cancelled.has(message.id)) return;
    const tensor = await extractor(message.texts, { pooling: 'mean', normalize: true });
    if (cancelled.has(message.id)) return;
    const dimension = tensor.dims[tensor.dims.length - 1] ?? 0;
    if (!dimension) throw new Error('Semantic model returned an empty vector');
    const data = Array.from(tensor.data as unknown as ArrayLike<number>);
    const vectors = message.texts.map((_, row) => data.slice(row * dimension, (row + 1) * dimension));
    parentPort?.postMessage({ type: 'result', id: message.id, vectors });
  } catch (caught) {
    const error = caught instanceof Error ? caught : new Error(String(caught));
    parentPort?.postMessage({ type: 'error', id: message.id, message: error.message });
  } finally {
    cancelled.delete(message.id);
    if (activeRequestId === message.id) activeRequestId = undefined;
  }
}

parentPort?.on('message', (message: WorkerRequest) => {
  if (message.type === 'cancel') {
    cancelled.add(message.id);
    return;
  }
  queue = queue.then(() => embed(message), () => embed(message));
});
