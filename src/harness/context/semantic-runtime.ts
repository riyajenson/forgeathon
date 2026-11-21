import path from 'node:path';
import { repoRoot } from '../repo-root';

/**
 * Semantic reranking (forge.context.semanticSearch) needs @huggingface/transformers, which is not a dependency of
 * the harness: scripts/enable-semantic-search.sh installs it, CPU-only, into src/harness/semantic-runtime.
 */
export const SEMANTIC_RUNTIME_MISSING =
  'semantic search is on but its runtime is not installed (run scripts/enable-semantic-search.sh); ranking stayed lexical';

/** FORGE_SEMANTIC_RUNTIME, else src/harness/semantic-runtime in this repository. */
export function semanticRuntimeDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env['FORGE_SEMANTIC_RUNTIME'];
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(repoRoot(), 'src', 'harness', 'semantic-runtime');
}
