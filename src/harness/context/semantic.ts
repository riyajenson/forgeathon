import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { IndexedChunk } from './workspace-index';
import { semanticRuntimeDir } from './semantic-runtime';

export const SEMANTIC_MODEL_ID = 'onnx-community/all-MiniLM-L6-v2-ONNX';
export const SEMANTIC_MODEL_REVISION = '2a90286a00a3fba4a0c16c5ea113091359ad5c86';

export interface SemanticProgress {
  status: string;
  progress?: number;
  loaded?: number;
  total?: number;
  file?: string;
  name?: string;
  message?: string;
}

export type SemanticProgressHandler = (event: SemanticProgress) => void;

export interface SemanticEmbeddingWorker {
  embed(texts: readonly string[], signal?: AbortSignal, onProgress?: SemanticProgressHandler): Promise<readonly number[][]>;
  dispose(): Promise<void>;
}

export interface ThreadEmbeddingClientOptions {
  workerPath?: string;
  modelId?: string;
  revision?: string;
  cacheDir?: string;
  /** Where the opt-in @huggingface/transformers runtime is installed (default: semanticRuntimeDir()). */
  runtimeDir?: string;
}

interface EmbedPending {
  resolve: (vectors: readonly number[][]) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  onProgress?: SemanticProgressHandler;
  lastProgressKey?: string;
}

type WorkerMessage =
  | { type: 'progress'; id: number; event: SemanticProgress }
  | { type: 'result'; id: number; vectors: number[][] }
  | { type: 'error'; id: number; message: string };

function abortError(message = 'Semantic search cancelled'): Error {
  return Object.assign(new Error(message), { name: 'AbortError' });
}

export class ThreadEmbeddingClient implements SemanticEmbeddingWorker {
  private readonly worker: Worker;
  private readonly pending = new Map<number, EmbedPending>();
  private nextId = 1;
  private stopped = false;
  private termination: Promise<void> | undefined;

  constructor(options: ThreadEmbeddingClientOptions = {}) {
    const cacheDir = options.cacheDir ?? path.join(os.homedir(), '.cache', 'forgeathon', 'transformers');
    this.worker = new Worker(options.workerPath ?? path.join(__dirname, 'semantic-worker.js'), {
      workerData: {
        modelId: options.modelId ?? SEMANTIC_MODEL_ID,
        revision: options.revision ?? SEMANTIC_MODEL_REVISION,
        cacheDir,
        runtimeDir: options.runtimeDir ?? semanticRuntimeDir(),
      },
    });
    this.worker.on('message', (message: WorkerMessage) => this.onMessage(message));
    this.worker.on('error', (error) => { void this.stop(error); });
    this.worker.on('exit', (code) => {
      if (!this.stopped) void this.stop(new Error(`Semantic worker exited with code ${code}`));
    });
  }

  embed(texts: readonly string[], signal?: AbortSignal, onProgress?: SemanticProgressHandler): Promise<readonly number[][]> {
    if (this.stopped) return Promise.reject(new Error('Semantic worker is stopped'));
    if (signal?.aborted) return Promise.reject(abortError());

    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      let onAbort: (() => void) | undefined;
      const pending: EmbedPending = { resolve, reject };
      if (signal) {
        pending.signal = signal;
        onAbort = () => {
          const active = this.take(id);
          if (!active) return;
          try { this.worker.postMessage({ type: 'cancel', id }); } catch { /* worker is already stopping */ }
          active.reject(abortError());
          void this.stop(abortError());
        };
        pending.onAbort = onAbort;
      }
      if (onProgress) pending.onProgress = onProgress;
      this.pending.set(id, pending);
      if (signal && onAbort) {
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) { onAbort(); return; }
      }
      try {
        this.worker.postMessage({ type: 'embed', id, texts: [...texts] });
      } catch (error) {
        this.take(id)?.reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private onMessage(message: WorkerMessage): void {
    const pending = this.pending.get(message.id);
    if (!pending) return;
    if (message.type === 'progress') {
      const percent = typeof message.event.progress === 'number' ? Math.floor(message.event.progress) : '';
      const progressKey = `${message.event.status}:${percent}`;
      if (pending.lastProgressKey === progressKey) return;
      pending.lastProgressKey = progressKey;
      try { pending.onProgress?.(message.event); } catch { /* progress observers cannot break inference */ }
      return;
    }
    const finished = this.take(message.id);
    if (!finished) return;
    if (message.type === 'result') finished.resolve(message.vectors);
    else finished.reject(new Error(message.message));
  }

  private take(id: number): EmbedPending | undefined {
    const pending = this.pending.get(id);
    if (!pending) return undefined;
    this.pending.delete(id);
    if (pending.signal && pending.onAbort) pending.signal.removeEventListener('abort', pending.onAbort);
    return pending;
  }

  private async stop(reason: Error): Promise<void> {
    if (this.stopped) {
      await this.termination;
      return;
    }
    this.stopped = true;
    for (const id of [...this.pending.keys()]) this.take(id)?.reject(reason);
    this.termination = this.worker.terminate().then(() => undefined, () => undefined);
    await this.termination;
  }

  async dispose(): Promise<void> {
    await this.stop(new Error('Semantic worker disposed'));
  }
}

export interface LocalSemanticRankerOptions extends ThreadEmbeddingClientOptions {
  workerFactory?: () => SemanticEmbeddingWorker;
  onProgress?: SemanticProgressHandler;
  onUnavailable?: (error: Error) => void;
}

export function semanticChunkId(chunk: Pick<IndexedChunk, 'path' | 'startLine' | 'endLine'>): string {
  return `${chunk.path}:${chunk.startLine}:${chunk.endLine}`;
}

function embeddingText(chunk: IndexedChunk): string {
  const name = chunk.qualname ?? chunk.name ?? '';
  return `${chunk.path}\n${name}\n${chunk.text.slice(0, 6000)}`;
}

function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  if (!left.length || left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let i = 0; i < left.length; i++) {
    const a = left[i]!;
    const b = right[i]!;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  const divisor = Math.sqrt(leftNorm * rightNorm);
  return divisor > 0 ? dot / divisor : 0;
}

export class LocalSemanticRanker {
  private worker: SemanticEmbeddingWorker | undefined;
  /** Why the last rank() returned no scores, when it failed (cleared by the next success). */
  unavailable: Error | undefined;

  constructor(private readonly options: LocalSemanticRankerOptions = {}) {}

  async rank(query: string, chunks: readonly IndexedChunk[], signal?: AbortSignal, onProgress?: SemanticProgressHandler): Promise<ReadonlyMap<string, number>> {
    if (!query.trim() || !chunks.length || signal?.aborted) return new Map();

    const missing = chunks.filter((chunk) => !chunk.semanticVectors.has(semanticChunkId(chunk)));
    try {
      const texts = [query, ...missing.map(embeddingText)];
      const vectors = await this.client().embed(texts, signal, onProgress ?? this.options.onProgress);
      if (signal?.aborted) return new Map();
      if (vectors.length !== texts.length || !vectors[0]?.length) throw new Error('Semantic worker returned incomplete embeddings');

      const queryVector = vectors[0]!;
      for (let i = 0; i < missing.length; i++) {
        const vector = vectors[i + 1];
        if (vector?.length) missing[i]!.semanticVectors.set(semanticChunkId(missing[i]!), [...vector]);
      }

      const scores = new Map<string, number>();
      for (const chunk of chunks) {
        const id = semanticChunkId(chunk);
        const vector = chunk.semanticVectors.get(id);
        if (vector) scores.set(id, cosineSimilarity(queryVector, vector));
      }
      this.unavailable = undefined;
      return scores;
    } catch (caught) {
      const error = caught instanceof Error ? caught : new Error(String(caught));
      if (!(signal?.aborted || error.name === 'AbortError')) this.unavailable = error;
      if (signal?.aborted || error.name === 'AbortError') {
        const worker = this.worker;
        this.worker = undefined;
        await worker?.dispose();
        return new Map();
      }
      try { this.options.onUnavailable?.(error); } catch { /* fallback observers cannot block lexical retrieval */ }
      return new Map();
    }
  }

  private client(): SemanticEmbeddingWorker {
    if (!this.worker) {
      this.worker = this.options.workerFactory?.() ?? new ThreadEmbeddingClient({
        ...(this.options.workerPath ? { workerPath: this.options.workerPath } : {}),
        ...(this.options.modelId ? { modelId: this.options.modelId } : {}),
        ...(this.options.revision ? { revision: this.options.revision } : {}),
        ...(this.options.cacheDir ? { cacheDir: this.options.cacheDir } : {}),
        ...(this.options.runtimeDir ? { runtimeDir: this.options.runtimeDir } : {}),
      });
    }
    return this.worker;
  }

  async dispose(): Promise<void> {
    const worker = this.worker;
    this.worker = undefined;
    await worker?.dispose();
  }
}
