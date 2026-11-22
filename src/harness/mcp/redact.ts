// Command output is redacted before it reaches the model, the panel or a log: provider keys known to this process
// and common credential shapes. A sandboxed command cannot read the home directory, but a key can still sit in a
// workspace file or be printed by a test; this is the second line.
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const REDACTED = '[REDACTED]';

/** Environment variable names that hold credentials (also withheld from commands). */
export const SECRET_ENV = /KEY|TOKEN|SECRET|PASSW|CREDENTIAL|AUTH|COOKIE|PRIVATE|SESSION/i;

/** Credential shapes: provider API keys, cloud and VCS tokens, bearer tokens, PEM private keys. */
export const KEY_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
  /\bnvapi-[A-Za-z0-9_-]{16,}/g,
  /\bsk-or-v1-[A-Za-z0-9]{16,}/g,
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g,
  /\bgsk_[A-Za-z0-9]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{16,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\bhf_[A-Za-z0-9]{20,}/g,
];
/** NAME=value or "name": "value" where the name says it is a credential: keep the name, redact the value. */
const ASSIGNMENT = /\b([A-Za-z0-9_.-]*(?:api[_-]?key|secret|token|passw(?:or)?d|credential)[A-Za-z0-9_.-]*["']?\s*[:=]\s*["']?)([^\s"',;]{8,})/gi;
const BEARER = /\b(Bearer\s+)([A-Za-z0-9._~+/-]{16,}=*)/g;

/**
 * Values to redact verbatim: every credential-named variable of this process (8+ characters), and the provider
 * keys named by `apiKeyEnv` in the Forge model config, when it is found.
 */
export function secretValues(env: NodeJS.ProcessEnv = process.env, configPaths: readonly string[] = forgeModelConfigs()): string[] {
  const names = new Set(Object.keys(env).filter((k) => SECRET_ENV.test(k)));
  for (const p of configPaths) {
    try { for (const m of readFileSync(p, 'utf8').matchAll(/"apiKeyEnv"\s*:\s*"([A-Za-z_][A-Za-z0-9_]*)"/g)) names.add(m[1]!); } catch { /* absent */ }
  }
  const values = [...names].map((n) => env[n]).filter((v): v is string => typeof v === 'string' && v.length >= 8);
  return [...new Set(values)].sort((a, b) => b.length - a.length);
}

/** Replaces known secret values and credential shapes; returns the text and how many replacements were made. */
export function redact(text: string, values: readonly string[] = secretValues()): { text: string; count: number } {
  let count = 0;
  let out = text;
  for (const v of values) {
    if (!out.includes(v)) continue;
    const parts = out.split(v);
    count += parts.length - 1;
    out = parts.join(REDACTED);
  }
  for (const re of KEY_PATTERNS) out = out.replace(re, () => { count++; return REDACTED; });
  out = out.replace(BEARER, (_m, p: string, v: string) => { if (v === REDACTED) return _m; count++; return `${p}${REDACTED}`; });
  out = out.replace(ASSIGNMENT, (m, p: string, v: string) => { if (v.startsWith(REDACTED)) return m; count++; return `${p}${REDACTED}`; });
  return { text: out, count };
}

/** The Forge repo's model configs (config/models*.json), found by walking up from this module; empty when installed elsewhere. */
export function forgeModelConfigs(from: string = __dirname): string[] {
  const root = forgeRepoRoot(from);
  return root ? ['models.json', 'models.example.json', 'models.mock.example.json'].map((f) => path.join(root, 'config', f)) : [];
}

export function forgeRepoRoot(from: string = __dirname): string | undefined {
  let dir = from;
  for (let i = 0; i < 8; i++) {
    try { readFileSync(path.join(dir, 'agent', 'forge-coder.json')); readFileSync(path.join(dir, 'config', 'models.example.json')); return dir; } catch { /* keep walking */ }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return undefined;
}
