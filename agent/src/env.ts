// Reads the repo-root .env WITHOUT putting it into process.env. The root .env also holds the keeper key and the
// contract's full-access key; the agent process must never even have them in memory. Only these names are picked.
import { existsSync, readFileSync } from 'node:fs';

export const ALLOWED_ENV = [
  'NEAR_NETWORK',
  'NEAR_RPC',
  'DMW_CONTRACT',
  'DMW_AGENT_KEY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL',
  'OPENAI_API_KEY',
  'OPENAI_MODEL',
  'NEAR_AI_API_KEY',
  'NEAR_AI_MODEL',
] as const;

export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

/** process env wins over files; files are filtered to ALLOWED_ENV. */
export function loadAgentEnv(files: string[], processEnv: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const f of files) {
    if (!existsSync(f)) continue;
    const parsed = parseDotenv(readFileSync(f, 'utf8'));
    for (const k of ALLOWED_ENV) if (parsed[k] && env[k] === undefined) env[k] = parsed[k];
  }
  for (const k of ALLOWED_ENV) if (processEnv[k]) env[k] = processEnv[k];
  return env;
}
