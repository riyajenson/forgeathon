// Idempotent spike setup: mock model providers, the "vscode" MCP connector and three agents.
import fs from 'node:fs';
import { TrueForge } from '@truefoundry/trueforge-sdk';

const client = new TrueForge({ baseUrl: 'http://127.0.0.1:8790', timeoutInSeconds: 60 });
const mcpToken = fs.readFileSync('.data/mcp-token', 'utf8').trim();

const model = { name: 'm1', modelId: 'mock-1', properties: { contextLength: 128000, maxOutputTokens: 4096 } };
const providers = [
  { name: 'mock', baseUrl: 'http://127.0.0.1:47700/v1', apiKey: 'spike-good-key' },
  { name: 'mockbad', baseUrl: 'http://127.0.0.1:47700/v1', apiKey: 'spike-wrong-key' },
  { name: 'mockdead', baseUrl: 'http://127.0.0.1:47799/v1', apiKey: 'spike-good-key' },
  // Non-routable address: connections hang instead of being refused.
  { name: 'mockhole', baseUrl: 'http://10.255.255.1/v1', apiKey: 'spike-good-key' },
];
for (const p of providers) {
  await client.settings.modelProviders.createOrUpdate({
    manifest: { type: 'custom', name: p.name, baseUrl: p.baseUrl, auth: { apiKey: p.apiKey }, models: [model] },
  });
  console.log(`provider ${p.name} upserted`);
}

await client.settings.mcpServers.createOrUpdate({
  manifest: {
    type: 'remote',
    name: 'vscode',
    url: 'http://127.0.0.1:47615/mcp',
    description: 'VS Code editor tools (spike stub)',
    auth: { type: 'header', headers: { Authorization: `Bearer ${mcpToken}` } },
  },
});
console.log('mcp server vscode upserted');

const models = await client.models.list();
console.log('models.list():', JSON.stringify(models, null, 1).slice(0, 3000));
const tools = await client.mcpServers.listTools('vscode');
console.log('mcpServers.listTools(vscode):', JSON.stringify(tools, null, 1));

// defaultApproval: omit requireApprovalForTools to see how the @write/@destructive default treats our annotations.
function spec(modelName, defaultApproval = false) {
  return {
    model: { name: modelName },
    instructions: 'Spike agent. Use the tools when the scenario asks for them.',
    mcpServers: [{
      name: 'vscode',
      enableTools: ['@all'],
      preloadTools: ['read_file', 'propose_edit'],
      ...(defaultApproval ? {} : { requireApprovalForTools: ['propose_edit'] }),
    }],
    config: {
      sandbox: { enabled: false },
      dynamicSubAgents: { enabled: false },
      generativeUi: { enabled: false },
      askUserQuestions: { enabled: false },
      contextManagement: { compaction: { enabled: true, trigger: { type: 'input_tokens', value: 100000 } }, largeToolResponse: { enabled: false } },
      iterationLimit: 10,
    },
  };
}

const agents = [
  { name: 'spike-agent', model: 'mock/m1' },
  { name: 'spike-401', model: 'mockbad/m1' },
  { name: 'spike-refused', model: 'mockdead/m1' },
  { name: 'spike-default', model: 'mock/m1', defaultApproval: true },
  { name: 'spike-hole', model: 'mockhole/m1' },
];
for (const a of agents) {
  const manifest = spec(a.model, a.defaultApproval);
  const page = await client.agents.list({ agentName: a.name });
  const existing = page.data.find((x) => x.name === a.name);
  if (existing) await client.agents.update(existing.id, { description: `P0 spike agent (${a.model})`, manifest });
  else await client.agents.create({ name: a.name, description: `P0 spike agent (${a.model})`, manifest });
  console.log(`agent ${a.name} ${existing ? 'updated' : 'created'} with model ${a.model}`);
}
