// Idempotent TrueForge setup: model providers, the editor MCP connector, and the agents with their
// fallback variants. Pure builders are separated from the SDK calls so they can be unit tested.
import type { TrueForgeClient } from '../trueforge/sdk';

export type ProviderType = 'anthropic' | 'openai' | 'google-gemini' | 'fireworks' | 'together' | 'moonshot' | 'zai' | 'alibaba' | 'custom';

export interface ModelConfig {
  name: string;
  modelId: string;
  contextLength?: number;
  maxOutputTokens?: number;
}

export interface ProviderConfig {
  type: ProviderType;
  /** Required for custom providers; built-in provider types are named after the type. */
  name?: string;
  baseUrl?: string;
  /** Environment variable holding the API key. The key itself never appears in config or logs. */
  apiKeyEnv?: string;
  /** Skip silently when the key is missing and no agent uses this provider. */
  optional?: boolean;
  models: ModelConfig[];
}

export interface ModelsConfig {
  providers: ProviderConfig[];
  agents: { primaryModel: string; fallbackModel: string };
  connector?: { name?: string; url?: string };
}

export interface AgentTemplate {
  name: string;
  description: string;
  manifest: Record<string, unknown> & { model?: { params?: Record<string, unknown> } };
}

export interface AgentDefinition {
  name: string;
  description: string;
  manifest: Record<string, unknown>;
}

export const FALLBACK_SUFFIX = '-fallback';
export const DEFAULT_CONNECTOR = { name: 'vscode', url: 'http://127.0.0.1:47615/mcp' };

export function providerName(p: ProviderConfig): string {
  if (p.type === 'custom') {
    if (!p.name) throw new Error('a custom provider needs a "name"');
    return p.name;
  }
  return p.name ?? p.type;
}

const providerOf = (fqn: string) => fqn.split('/')[0] ?? '';

/** TrueForge ResourceName rule (verified: 0.185.1 rejects other provider and model names with 400). */
export const RESOURCE_NAME = /^[a-z][a-z0-9-]{0,62}[a-z0-9]$/;

export function validateConfig(cfg: ModelsConfig): string[] {
  const problems: string[] = [];
  if (!Array.isArray(cfg.providers) || cfg.providers.length === 0) problems.push('providers must be a non-empty array');
  const known = new Set<string>();
  for (const p of cfg.providers ?? []) {
    let name: string;
    try { name = providerName(p); } catch (e) { problems.push((e as Error).message); continue; }
    if (!RESOURCE_NAME.test(name)) problems.push(`provider name "${name}" must be lowercase letters, digits and hyphens`);
    if (p.type === 'custom' && !p.baseUrl) problems.push(`custom provider "${name}" needs a baseUrl`);
    if (!Array.isArray(p.models) || p.models.length === 0) problems.push(`provider "${name}" needs at least one model`);
    for (const m of p.models ?? []) {
      if (!RESOURCE_NAME.test(m.name ?? '')) problems.push(`model name "${m.name}" of provider "${name}" must be 2–64 lowercase letters, digits and hyphens (put the real id in modelId)`);
      known.add(`${name}/${m.name}`);
    }
  }
  const { primaryModel, fallbackModel } = cfg.agents ?? ({} as ModelsConfig['agents']);
  if (!primaryModel || !fallbackModel) problems.push('agents.primaryModel and agents.fallbackModel are required');
  else {
    if (!known.has(primaryModel)) problems.push(`agents.primaryModel "${primaryModel}" is not a configured <provider>/<model>`);
    if (!known.has(fallbackModel)) problems.push(`agents.fallbackModel "${fallbackModel}" is not a configured <provider>/<model>`);
    if (providerOf(primaryModel) === providerOf(fallbackModel)) problems.push('the fallback model must use a different provider than the primary');
  }
  return problems;
}

export type ProviderPlan =
  | { action: 'upsert'; name: string; manifest: Record<string, unknown> }
  | { action: 'skip'; name: string; reason: string };

/** Builds the TrueForge provider manifest; reads the key from `env` without ever returning it in a message. */
export function planProvider(p: ProviderConfig, env: NodeJS.ProcessEnv, usedProviders: Set<string>): ProviderPlan {
  const name = providerName(p);
  const key = p.apiKeyEnv ? env[p.apiKeyEnv] : undefined;
  const used = usedProviders.has(name);
  if (!key && p.type !== 'custom') {
    if (!used && p.optional !== false) return { action: 'skip', name, reason: `${p.apiKeyEnv ?? 'API key variable'} is not set and no agent uses it` };
    throw new Error(`provider "${name}" is used by the agents but ${p.apiKeyEnv ?? 'its API key variable'} is not set`);
  }
  if (!key && p.type === 'custom' && !used && p.optional) return { action: 'skip', name, reason: `${p.apiKeyEnv ?? 'API key variable'} is not set and no agent uses it` };
  const models = p.models.map((m) => ({
    name: m.name,
    modelId: m.modelId,
    properties: {
      ...(m.contextLength ? { contextLength: m.contextLength } : {}),
      ...(m.maxOutputTokens ? { maxOutputTokens: m.maxOutputTokens } : {}),
    },
  }));
  const auth = key ? { auth: { apiKey: key } } : {};
  const manifest = p.type === 'custom'
    ? { type: 'custom', name, baseUrl: p.baseUrl, ...auth, models }
    : { type: p.type, ...auth, ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}), models };
  return { action: 'upsert', name, manifest };
}

/** Primary agents use the primary model; `<name>-fallback` variants are generated with the fallback model. */
export function buildAgents(templates: AgentTemplate[], cfg: ModelsConfig, connectorName: string): AgentDefinition[] {
  const out: AgentDefinition[] = [];
  for (const t of templates) {
    for (const [suffix, model, note] of [['', cfg.agents.primaryModel, ''], [FALLBACK_SUFFIX, cfg.agents.fallbackModel, ' (fallback model)']] as const) {
      const manifest = structuredClone(t.manifest) as Record<string, unknown>;
      const params = (t.manifest.model?.params ?? {}) as Record<string, unknown>;
      manifest['model'] = { name: model, ...(Object.keys(params).length ? { params } : {}) };
      const servers = manifest['mcpServers'];
      if (Array.isArray(servers)) for (const s of servers as Array<Record<string, unknown>>) if (s['name'] === 'vscode') s['name'] = connectorName;
      out.push({ name: `${t.name}${suffix}`, description: `${t.description}${note}`, manifest });
    }
  }
  return out;
}

/** Replaces secrets in manifests for printing. */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, /^(apikey|api_key|authorization|token|access_token|secret)$/i.test(k) ? '***' : redact(v)]));
  }
  return value;
}

export interface SetupOptions {
  client: TrueForgeClient;
  cfg: ModelsConfig;
  templates: AgentTemplate[];
  env: NodeJS.ProcessEnv;
  log(line: string): void;
  dryRun?: boolean;
}

export interface SetupReport {
  providers: ProviderPlan[];
  connector: string;
  agents: Array<{ name: string; model: string; action: 'created' | 'updated' | 'planned' }>;
  missingModels: string[];
}

export async function runSetup(o: SetupOptions): Promise<SetupReport> {
  const problems = validateConfig(o.cfg);
  if (problems.length) throw new Error(`invalid models config:\n- ${problems.join('\n- ')}`);
  const used = new Set([providerOf(o.cfg.agents.primaryModel), providerOf(o.cfg.agents.fallbackModel)]);
  const plans = o.cfg.providers.map((p) => planProvider(p, o.env, used));
  const connector = { ...DEFAULT_CONNECTOR, ...(o.cfg.connector ?? {}) };
  const agents = buildAgents(o.templates, o.cfg, connector.name);
  const report: SetupReport = { providers: plans, connector: connector.name, agents: [], missingModels: [] };

  for (const plan of plans) {
    if (plan.action === 'skip') { o.log(`provider ${plan.name}: skipped (${plan.reason})`); continue; }
    if (o.dryRun) { o.log(`provider ${plan.name}: would upsert ${JSON.stringify(redact(plan.manifest))}`); continue; }
    await o.client.settings.modelProviders.createOrUpdate({ manifest: plan.manifest as never });
    o.log(`provider ${plan.name}: upserted`);
  }

  // Agents reference the connector by name, so it must exist; the extension re-registers it with its live
  // URL and a fresh token every time it starts.
  if (o.dryRun) o.log(`connector ${connector.name}: would upsert placeholder at ${connector.url}`);
  else {
    const existing = await o.client.settings.mcpServers.get(connector.name).then(() => true, () => false);
    if (!existing) {
      await o.client.settings.mcpServers.createOrUpdate({
        manifest: { type: 'remote', name: connector.name, url: connector.url, description: 'VS Code editor tools (registered by the extension at start)', auth: { type: 'header', headers: { Authorization: 'Bearer set-by-extension' } } },
      });
      o.log(`connector ${connector.name}: created placeholder (the extension registers its live URL and token)`);
    } else o.log(`connector ${connector.name}: exists (left as registered by the extension)`);
  }

  for (const a of agents) {
    const model = String((a.manifest['model'] as { name: string }).name);
    if (o.dryRun) {
      o.log(`agent ${a.name}: would upsert with model ${model}`);
      report.agents.push({ name: a.name, model, action: 'planned' });
      continue;
    }
    const page = await o.client.agents.list({ agentName: a.name });
    const found = page.data.find((x) => x.name === a.name);
    if (found) await o.client.agents.update(found.id, { description: a.description, manifest: a.manifest as never });
    else await o.client.agents.create({ name: a.name, description: a.description, manifest: a.manifest as never });
    o.log(`agent ${a.name}: ${found ? 'updated' : 'created'} (model ${model})`);
    report.agents.push({ name: a.name, model, action: found ? 'updated' : 'created' });
  }

  if (!o.dryRun) {
    const available = new Set((await o.client.models.list()).data.map((m) => m.name));
    report.missingModels = [o.cfg.agents.primaryModel, o.cfg.agents.fallbackModel].filter((m) => !available.has(m));
    if (report.missingModels.length) o.log(`WARNING: TrueForge does not list ${report.missingModels.join(', ')}; check provider and model names`);
    else o.log(`models available: ${o.cfg.agents.primaryModel} (primary), ${o.cfg.agents.fallbackModel} (fallback)`);
  }
  return report;
}
