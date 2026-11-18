// Tokenising for retrieval: identifiers are split (snake_case, camelCase) and lightly normalised.

const STOP = new Set([
  'a', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'can', 'do', 'does', 'each', 'else', 'for',
  'from', 'has', 'have', 'if', 'in', 'into', 'is', 'it', 'its', 'may', 'must', 'no', 'not', 'of', 'on', 'or', 'other',
  'our', 'should', 'so', 'such', 'than', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'this', 'those', 'to',
  'too', 'use', 'used', 'using', 'was', 'well', 'were', 'when', 'which', 'while', 'will', 'with', 'would', 'you', 'your',
  'also', 'add', 'new', 'make', 'every', 'all', 'it', 'one', 'two', 'get', 'set', 'self', 'cls', 'def', 'class', 'return',
  'none', 'true', 'false', 'import', 'pass', 'py', 'value', 'values', 'via', 'like', 'only', 'same', 'need', 'needs',
]);

/** Light normalisation: lowercase and drop a plural "s" ("commands" → "command", "keys" → "key"). */
export function normalise(word: string): string {
  const w = word.toLowerCase();
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is')) return w.slice(0, -1);
  return w;
}

/** "routes_command" → ["routes", "command"]; "getDebugFlag" → ["get", "debug", "flag"]. */
export function splitIdentifier(id: string): string[] {
  return id
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
}

/**
 * Search terms in `text`: each identifier's parts, plus the whole identifier when it is compound
 * (so "routes_command" yields "route", "command" and "routes_command").
 */
export function terms(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
    const id = m[0];
    const parts = splitIdentifier(id);
    if (parts.length > 1) {
      const whole = id.toLowerCase();
      if (whole.length >= 3) out.push(whole);
    }
    for (const p of parts) {
      const n = normalise(p);
      if (n.length >= 2 && !STOP.has(n) && !/^\d+$/.test(n)) out.push(n);
    }
  }
  return out;
}

export function countTerms(list: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of list) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);
