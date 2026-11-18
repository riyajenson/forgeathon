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
  const [anthropic, openai, local] = example.providers;
  const used = new Set(['anthropic', 'openai']);
  const plan = planProvider(anthropic!, { ANTHROPIC_API_KEY: 'sk-secret' }, used);
  assert.equal(plan.action, 'upsert');
  assert.equal(plan.action === 'upsert' && (plan.manifest['auth'] as { apiKey: string }).apiKey, 'sk-secret');
  assert.doesNotMatch(JSON.stringify(redact(plan)), /sk-secret/);
  assert.throws(() => planProvider(openai!, {}, used), /OPENAI_API_KEY is not set/);
  assert.equal(planProvider(local!, {}, used).action, 'skip');
  assert.equal(planProvider(openai!, {}, new Set(['anthropic'])).action, 'skip');
});

test('buildAgents makes primary and -fallback variants from each template, with the right tools and limits', () => {
  const agents = buildAgents(templates, example, 'vscode');
  assert.deepEqual(agents.map((a) => a.name), ['forge-coder', 'forge-coder-fallback', 'forge-inline', 'forge-inline-fallback']);
  const byName = Object.fromEntries(agents.map((a) => [a.name, a.manifest as Record<string, any>]));
  assert.equal(byName['forge-coder']!['model'].name, 'anthropic/claude-sonnet-5-5');
  assert.equal(byName['forge-coder-fallback']!['model'].name, 'openai/gpt-5-2');
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
  const report = await runSetup({ client, cfg: example, templates, env: { ANTHROPIC_API_KEY: 'sk-ant-xyz', OPENAI_API_KEY: 'sk-oai-xyz' }, log: (l) => lines.push(l), dryRun: true });
  assert.equal(report.agents.length, 4);
  assert.doesNotMatch(lines.join('\n'), /sk-ant-xyz|sk-oai-xyz/);
  assert.match(lines.join('\n'), /"apiKey":"\*\*\*"/);
  assert.match(lines.join('\n'), /"maxOutputTokens":8192/, 'non-secret fields stay readable');
});
