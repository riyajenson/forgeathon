import { repoRoot } from '../repo-root';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { buildAgents, planProvider, redact, runSetup, validateConfig, type AgentTemplate, type ModelsConfig } from './setup';

const repo = repoRoot();
const templates: AgentTemplate[] = readdirSync(path.join(repo, 'agent')).filter((f) => f.endsWith('.json')).sort()
  .map((f) => JSON.parse(readFileSync(path.join(repo, 'agent', f), 'utf8')) as AgentTemplate);
const example = JSON.parse(readFileSync(path.join(repo, 'config', 'models.example.json'), 'utf8')) as ModelsConfig;

test('the committed example config is valid', () => {
  assert.deepEqual(validateConfig(example), []);
});

test('the example config: NVIDIA primary with an OpenRouter fallback that can carry Task B; Groq stays a spare; profiles are valid', () => {
  assert.equal(example.agents.primaryModel, 'nvidia/nemotron-3-ultra');
  assert.equal(example.agents.fallbackModel, 'openrouter/nemotron-3-ultra-free');
  const fb = example.providers.find((p) => p.name === 'openrouter')!.models.find((m) => m.name === 'nemotron-3-ultra-free')!;
  assert.ok((fb.contextLength ?? 0) >= 131072, 'room for Task B context');
  assert.ok(example.providers.some((p) => p.name === 'groq'), 'Groq is still configured');
  const profiles = example.profiles ?? {};
  assert.deepEqual(Object.keys(profiles), ['nvidia-free', 'openrouter-free', 'openrouter-paid']);
  assert.deepEqual({ primaryModel: profiles['nvidia-free']!.primaryModel, fallbackModel: profiles['nvidia-free']!.fallbackModel }, example.agents, 'the default profile is the committed default');
  assert.equal(profiles['openrouter-paid']!.primaryModel, 'openrouter/qwen3-coder-next');
  assert.deepEqual(Object.entries(profiles).filter(([, p]) => p.paid).map(([n]) => n), ['openrouter-paid'], 'only the paid profile is marked paid');
});

test('validateConfig checks every profile like agents', () => {
  const problems = validateConfig({ ...example, profiles: { 'Bad': { primaryModel: 'openrouter/qwen3-coder-next', fallbackModel: 'openrouter/nemotron-3-ultra-free' }, 'x': { primaryModel: 'nope/m', fallbackModel: 'nvidia/nemotron-3-ultra' } } }).join('\n');
  assert.match(problems, /profile name "Bad"/);
  assert.match(problems, /profiles\.Bad: the fallback model must use a different provider/);
  assert.match(problems, /profiles\.x\.primaryModel "nope\/m" is not a configured/);
});

test('validateConfig catches unknown models, same-provider fallback and bad names', () => {
  const bad: ModelsConfig = {
    providers: [{ type: 'custom', name: 'Bad_Name', baseUrl: 'http://x', models: [{ name: 'm', modelId: 'm' }] }, { type: 'openai', models: [{ name: 'a', modelId: 'a' }, { name: 'b', modelId: 'b' }] }],
    agents: { primaryModel: 'openai/a', fallbackModel: 'openai/b' },
  };
  const problems = validateConfig(bad).join('\n');
  assert.match(problems, /lowercase/);
  assert.match(problems, /different provider/);
  assert.match(validateConfig({ ...bad, agents: { primaryModel: 'x/y', fallbackModel: 'openai/a' } }).join('\n'), /"x\/y" is not a configured/);
});

test('planProvider reads keys from env only, skips unused providers, refuses missing keys for used ones', () => {
  const byType = (t: string) => example.providers.find((p) => p.type === t)!;
  const anthropic = byType('anthropic');
  const openai = byType('openai');
  const groq = example.providers.find((p) => p.name === 'groq')!;
  const used = new Set(['anthropic', 'openai']);
  const plan = planProvider(anthropic, { ANTHROPIC_API_KEY: 'sk-secret' }, used);
  assert.equal(plan.action, 'upsert');
  assert.equal(plan.action === 'upsert' && (plan.manifest['auth'] as { apiKey: string }).apiKey, 'sk-secret');
  assert.doesNotMatch(JSON.stringify(redact(plan)), /sk-secret/);
  assert.throws(() => planProvider(openai, {}, used), /OPENAI_API_KEY is not set/);
  assert.equal(planProvider(groq, {}, used).action, 'skip');
  assert.equal(planProvider(openai, {}, new Set(['anthropic'])).action, 'skip');
  const g = planProvider(groq, { GROQ_API_KEY: 'gsk' }, new Set(['groq']));
  assert.ok(g.action === 'upsert' && g.manifest['type'] === 'custom' && g.manifest['baseUrl'] === 'https://api.groq.com/openai/v1');
  const gem = planProvider(byType('google-gemini'), { GEMINI_API_KEY: 'g' }, new Set(['google-gemini']));
  assert.ok(gem.action === 'upsert');
  assert.deepEqual(gem.action === 'upsert' && (gem.manifest['models'] as Array<{ properties: unknown }>)[0]!.properties,
    { contextLength: 1048576, maxOutputTokens: 65536, reasoningEfforts: ['low', 'medium', 'high'] });
});

test('buildAgents makes primary and -fallback variants from each template, with the right tools and limits', () => {
  const agents = buildAgents(templates, example, 'vscode');
  assert.deepEqual(agents.map((a) => a.name), ['forge-coder', 'forge-coder-fallback', 'forge-inline', 'forge-inline-fallback']);
  const byName = Object.fromEntries(agents.map((a) => [a.name, a.manifest as Record<string, any>]));
  assert.equal(byName['forge-coder']!['model'].name, example.agents.primaryModel);
  assert.equal(byName['forge-coder-fallback']!['model'].name, example.agents.fallbackModel);
  assert.equal(byName['forge-coder']!['model'].params.parallelToolCalls, false);
  for (const a of agents) {
    const m = a.manifest as Record<string, any>;
    assert.deepEqual(m['mcpServers'][0].requireApprovalForTools, ['propose_edit', 'run_command']);
    assert.equal(m['config'].dynamicSubAgents.enabled, false);
    assert.equal(m['config'].generativeUi.enabled, false);
    assert.equal(m['config'].askUserQuestions.enabled, false);
    assert.equal(m['config'].sandbox.enabled, false);
    assert.equal(m['config'].contextManagement.largeToolResponse.enabled, false);
    assert.deepEqual(m['config'].contextManagement.compaction, { enabled: true, trigger: { type: 'input_tokens', value: 60000 } });
  }
  assert.equal(byName['forge-coder']!['config'].iterationLimit, 60);
  assert.equal(byName['forge-inline']!['config'].iterationLimit, 8);
  assert.deepEqual(byName['forge-inline']!['mcpServers'][0].enableTools, ['read_file', 'propose_edit']);
  assert.equal(buildAgents(templates, example, 'vscode-it')[0]!.manifest['mcpServers'] && (buildAgents(templates, example, 'vscode-it')[0]!.manifest['mcpServers'] as Array<{ name: string }>)[0]!.name, 'vscode-it');
  assert.equal((templates[0]!.manifest['model'] as Record<string, unknown>)['name'], undefined, 'templates are not mutated');
});

test('runSetup dry run touches nothing and never prints keys', async () => {
  const lines: string[] = [];
  const client = new Proxy({}, { get: () => { throw new Error('dry run must not call TrueForge'); } }) as never;
  const report = await runSetup({ client, cfg: example, templates, env: { GEMINI_API_KEY: 'sk-gem-xyz', GROQ_API_KEY: 'gsk-xyz' }, log: (l) => lines.push(l), dryRun: true });
  assert.equal(report.agents.length, 4);
  assert.doesNotMatch(lines.join('\n'), /sk-gem-xyz|gsk-xyz/);
  assert.match(lines.join('\n'), /"apiKey":"\*\*\*"/);
  assert.match(lines.join('\n'), /"maxOutputTokens":65536/, 'non-secret fields stay readable');
  assert.match(lines.join('\n'), /provider anthropic: skipped/, 'providers without a key that no agent uses are skipped');
});
