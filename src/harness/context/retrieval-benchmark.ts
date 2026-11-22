export type RetrievalWorkspace = 'forge' | 'flask';

export interface RetrievalBenchmarkCase {
  id: string;
  query: string;
  expectedPaths: readonly string[];
  workspace: RetrievalWorkspace;
  budgetTokens?: number;
}

export interface RetrievalBenchmarkResult {
  caseId: string;
  expectedPaths: readonly string[];
  rankedPaths: readonly string[];
  packedPaths: readonly string[];
  packedTokens: number;
  elapsedMs: number;
}

export interface RetrievalMetrics {
  recallAt5: number;
  mrr: number;
  relevantFilesPer1000Tokens: number;
  medianElapsedMs: number;
}

export function measureRetrieval(results: readonly RetrievalBenchmarkResult[]): RetrievalMetrics {
  const scored = results.filter((result) => result.expectedPaths.length > 0);
  const reciprocalRanks: number[] = [];
  let recallTotal = 0;

  for (const result of scored) {
    const expected = new Set(result.expectedPaths);
    const topFive = result.rankedPaths.slice(0, 5);
    const relevantTopFive = new Set(topFive.filter((candidate) => expected.has(candidate)));
    recallTotal += relevantTopFive.size / expected.size;

    const firstRelevant = result.rankedPaths.findIndex((candidate) => expected.has(candidate));
    reciprocalRanks.push(firstRelevant < 0 ? 0 : 1 / (firstRelevant + 1));
  }

  const rankedElapsed = results.map((result) => result.elapsedMs).sort((a, b) => a - b);
  const middle = Math.floor(rankedElapsed.length / 2);
  const medianElapsedMs = rankedElapsed.length === 0 ? 0
    : rankedElapsed.length % 2 === 1 ? rankedElapsed[middle]!
      : (rankedElapsed[middle - 1]! + rankedElapsed[middle]!) / 2;

  const packedTokens = results.reduce((sum, result) => sum + Math.max(0, result.packedTokens), 0);
  const relevantPackedFiles = results.reduce((sum, result) => {
    const expected = new Set(result.expectedPaths);
    return sum + new Set(result.packedPaths.filter((candidate) => expected.has(candidate))).size;
  }, 0);

  return {
    recallAt5: scored.length ? recallTotal / scored.length : 0,
    mrr: reciprocalRanks.length ? reciprocalRanks.reduce((sum, value) => sum + value, 0) / reciprocalRanks.length : 0,
    relevantFilesPer1000Tokens: packedTokens > 0 ? relevantPackedFiles * 1000 / packedTokens : 0,
    medianElapsedMs,
  };
}
