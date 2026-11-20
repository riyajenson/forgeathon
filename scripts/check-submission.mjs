#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const headings = ['Team', 'Starting point', 'Architecture on TrueForge', 'How context is selected', 'Model setup', 'Scorecard', 'Tools used', 'Known limitations and what you would do with another month'];
const filled = value => typeof value === 'string' && value.trim().length > 0 && !/<[^>]+>|\[mm:ss\]|\bTODO\b|\bTBD\b/i.test(value);
const url = value => { try { return filled(value) && ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; } };

/** Checks completeness of declared evidence, not the truth of a rehearsal or public link access. */
export function checkSubmission(writeup, evidence) {
  const errors = [];
  const placeholders = writeup.match(/<[^>\n]+>|\[mm:ss\]|\bTODO\b|\bTBD\b/gi) ?? [];
  if (placeholders.length) errors.push(`Write-up has unresolved placeholders: ${[...new Set(placeholders)].join(', ')}`);
  const actual = [...writeup.matchAll(/^##\s+\d+\.\s+(.+)$/gm)].map(m => m[1].trim());
  if (JSON.stringify(actual) !== JSON.stringify(headings)) errors.push('Write-up must contain the eight required headings in order.');
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return [...errors, 'Real-model evidence is missing. Copy config/rehearsal.example.json and record actual A/B/C results.'];
  if (!/^[a-f0-9]{40}$/i.test(evidence.repositoryCommit ?? '')) errors.push('Record the full tested repository commit.');
  if (!/^22d92470[a-f0-9]{0,32}$/i.test(evidence.flaskCommit ?? '')) errors.push('Record the pinned Flask commit (22d92470 or its full SHA).');
  if (!url(evidence.repositoryUrl)) errors.push('Record the repository URL.');
  if (!url(evidence.videoUrl)) errors.push('Record the final video URL.');
  const models = Array.isArray(evidence.models) ? evidence.models : [];
  for (const role of ['primary', 'fallback']) {
    const model = models.find(m => m?.role === role);
    if (!model || !filled(model.name) || /mock|scripted|demo-model/i.test(model.name) || !filled(model.hosting) ||
      typeof model.approximateCostUsd !== 'number' || !Number.isFinite(model.approximateCostUsd) || model.approximateCostUsd < 0) {
      errors.push(`Record the real ${role} model, hosting and nonnegative approximate cost.`);
    }
  }
  const tasks = Array.isArray(evidence.tasks) ? evidence.tasks : [];
  for (const task of ['A', 'B', 'C']) {
    const matches = tasks.filter(t => t?.task === task);
    if (matches.length !== 1) { errors.push(`Record exactly one real-model Task ${task} rehearsal.`); continue; }
    const run = matches[0];
    if (run.mode !== 'real' || run.passed !== true || !filled(run.model) || !models.some(m => m?.name === run.model) ||
      /mock|scripted|demo-model/i.test(run.model) || !url(run.sessionUrl) || !filled(run.verification) ||
      !filled(run.recordedAt) || !Number.isFinite(Date.parse(run.recordedAt)) || !/^\d{2}:\d{2}$/.test(run.videoTimestamp ?? '')) {
      errors.push(`Task ${task} needs a passed real-model run, configured model, session URL, verification, date and video timestamp.`);
    }
    for (const key of ['inputTokens', 'outputTokens']) if (!Number.isSafeInteger(run[key]) || run[key] < 0) errors.push(`Task ${task}: record nonnegative ${key} from session usage.`);
  }
  return errors;
}

/** The evidence must be for HEAD, or for an ancestor of HEAD followed only by documentation commits (docs/, *.md):
 * committing rehearsal.json itself, or the video URL, must not invalidate the evidence. */
export function commitError(recorded, head, isAncestor, changedSinceRecorded) {
  if (recorded.toLowerCase() === head.toLowerCase()) return undefined;
  const code = isAncestor ? changedSinceRecorded.filter(f => !f.startsWith('docs/') && !/^[^/]+\.md$/.test(f)) : [];
  if (isAncestor && !code.length) return undefined;
  return `Real-model evidence was recorded for ${recorded}; rehearse A/B/C on the current commit ${head}` +
    (isAncestor ? ` (changed since then outside docs: ${code.slice(0, 5).join(', ')}${code.length > 5 ? ', …' : ''}).` : '.');
}

export function main(args = process.argv.slice(2)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  let writeupPath = path.join(root, 'docs/writeup/WRITEUP.md');
  let evidencePath = path.join(root, 'docs/writeup/rehearsal.json');
  for (let i = 0; i < args.length; i += 2) {
    if (!['--writeup', '--evidence'].includes(args[i]) || !args[i + 1]) throw new Error('Usage: node scripts/check-submission.mjs [--writeup FILE] [--evidence FILE]');
    if (args[i] === '--writeup') writeupPath = path.resolve(args[i + 1]); else evidencePath = path.resolve(args[i + 1]);
  }
  const writeup = readFileSync(writeupPath, 'utf8');
  let evidence;
  try { evidence = JSON.parse(readFileSync(evidencePath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error(`Cannot parse rehearsal evidence: ${evidencePath}`); }
  const errors = checkSubmission(writeup, evidence);
  if (evidence?.repositoryCommit) {
    const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const head = git('rev-parse', 'HEAD'), recorded = evidence.repositoryCommit;
    let ancestor = false, changed = [];
    try { git('merge-base', '--is-ancestor', recorded, head); ancestor = true; changed = git('diff', '--name-only', recorded, head).split('\n').filter(Boolean); } catch { /* not an ancestor */ }
    const error = commitError(recorded, head, ancestor, changed);
    if (error) errors.push(error);
  }
  if (errors.length) {
    console.error('Submission evidence is incomplete:\n' + errors.map(e => `- ${e}`).join('\n'));
    return 1;
  }
  console.log('Evidence fields are complete. Manually verify claims, PDF page count, video duration and signed-out link access.');
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
