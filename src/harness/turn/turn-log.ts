// One JSON line per turn: models, attempts, tokens and timing. No prompts, code or tool output.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface AttemptRecord {
  agent: string;
  model: string;
  runtimeSessionId: string;
  status: 'done' | 'cancelled' | 'error';
  errorClass?: string;
  ms: number;
  inputTokens?: number;
  outputTokens?: number;
}

export interface TurnRecord {
  time: string;
  sessionId: string;
  turnId: string;
  mode: 'inline' | 'agent';
  status: 'done' | 'cancelled' | 'error';
  ms: number;
  attempts: AttemptRecord[];
  retries: number;
  fallback: boolean;
  toolCalls: number;
  reviews: number;
  inputTokens: number;
  outputTokens: number;
}

/** FORGE_TURN_LOG overrides the path; "off" disables the log. Default ~/.forge/turns.jsonl. */
export function defaultTurnLogPath(): string | undefined {
  const env = process.env['FORGE_TURN_LOG'];
  if (env === 'off') return undefined;
  return env || path.join(os.homedir(), '.forge', 'turns.jsonl');
}

export async function appendTurnLog(file: string | undefined, record: TurnRecord): Promise<void> {
  if (!file) return;
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, `${JSON.stringify(record)}\n`, 'utf8');
  } catch {
    // Logging must never affect a turn.
  }
}
