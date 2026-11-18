import { createHash } from 'node:crypto';

/** JSON with object keys sorted recursively; arrays keep their order. Mirrors JSON.stringify for undefined/functions. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : sortKeys(v)));
  if (value !== null && typeof value === 'object') {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) {
      const v = src[key];
      if (v === undefined || typeof v === 'function') continue;
      out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Name of TrueForge's meta tool for deferred MCP tools; the real arguments sit in its `input`. */
export const DEFERRED_CALL_TOOL = 'call_tool';

/**
 * The arguments the MCP tool itself will receive, given the tool call the model made.
 * For a deferred call (`call_tool {mcp_server, tool_name, input}`) that is the inner `input`.
 */
export function effectiveToolArgs(toolName: string, args: unknown): unknown {
  if (toolName === DEFERRED_CALL_TOOL && args !== null && typeof args === 'object') {
    const input = (args as Record<string, unknown>)['input'];
    return input === undefined ? {} : input;
  }
  return args;
}

/** Review key: sha256 of the canonical JSON of the tool's own arguments. */
export function canonicalArgsKey(args: unknown): string {
  return sha256Hex(canonicalJson(args));
}
