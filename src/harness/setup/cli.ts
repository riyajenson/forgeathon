// Usage: node scripts/setup-trueforge.mjs [--config config/models.json] [--agents agent] [--url http://127.0.0.1:8790] [--dry-run] [--no-subagents]
// TrueForge's dynamic sub-agents are on for agents whose template defines them (forge-coder); --no-subagents turns
// them off. --subagents is accepted (the default).
import { repoRoot } from '../repo-root';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createClient } from '../trueforge/sdk';
import { isTrueForgeUnreachable, safeMessage } from '../trueforge/errors';
import { runSetup, type AgentTemplate, type ModelsConfig } from './setup';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

async function main(): Promise<void> {
  const repo = repoRoot();
  const configPath = path.resolve(arg('--config', path.join(repo, 'config', 'models.json')));
  const agentsDir = path.resolve(arg('--agents', path.join(repo, 'agent')));
  const url = arg('--url', process.env['TRUEFORGE_URL'] ?? 'http://127.0.0.1:8790');
  const dryRun = process.argv.includes('--dry-run');
  const subAgents = !process.argv.includes('--no-subagents');

  let cfg: ModelsConfig;
  try {
    cfg = JSON.parse(await fs.readFile(configPath, 'utf8')) as ModelsConfig;
  } catch (e) {
    throw new Error(`cannot read ${configPath} (${safeMessage((e as Error).message)}). Copy config/models.example.json to config/models.json first.`);
  }
  const templates: AgentTemplate[] = [];
  for (const f of (await fs.readdir(agentsDir)).filter((n) => n.endsWith('.json')).sort()) {
    templates.push(JSON.parse(await fs.readFile(path.join(agentsDir, f), 'utf8')) as AgentTemplate);
  }
  if (!templates.length) throw new Error(`no agent templates in ${agentsDir}`);

  const { client } = await createClient(url);
  if (!dryRun) {
    try {
      await client.models.list();
    } catch (e) {
      throw new Error(isTrueForgeUnreachable(e) ? `TrueForge is not reachable at ${url}; start it first` : safeMessage((e as Error).message));
    }
  }
  console.log(`TrueForge ${url}${dryRun ? ' (dry run)' : ''}; config ${path.relative(process.cwd(), configPath)}; templates ${templates.map((t) => t.name).join(', ')}`);
  const report = await runSetup({ client, cfg, templates, env: process.env, log: (l) => console.log(`  ${l}`), dryRun, subAgents });
  if (report.missingModels.length) process.exitCode = 2;
}

main().catch((e) => {
  console.error(`setup failed: ${(e as Error).message}`);
  process.exitCode = 1;
});
