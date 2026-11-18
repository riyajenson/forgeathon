const FORBIDDEN_SEGMENTS = new Set(['.git', 'node_modules']);

/**
 * Normalises a model-supplied path to a workspace-relative POSIX path, or returns null if it is
 * absolute, escapes the workspace, or touches .git / node_modules.
 */
export function normalizeWorkspacePath(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const raw = input.trim().replace(/\\/g, '/');
  if (raw === '' || raw.includes('\0')) return null;
  if (raw.startsWith('/') || /^[a-zA-Z]:/.test(raw) || raw.startsWith('~')) return null;
  const parts: string[] = [];
  for (const seg of raw.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') return null;
    if (FORBIDDEN_SEGMENTS.has(seg)) return null;
    parts.push(seg);
  }
  return parts.length === 0 ? null : parts.join('/');
}
