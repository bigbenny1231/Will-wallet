import type { Brain } from '../types.js';
import { AnthropicBrain, NEARAI_BASE, NEARAI_DEFAULT_MODEL, OPENAI_BASE, OpenAICompatBrain, pickAnthropicModel, pickOpenAIModel } from './llm.js';
import { ScriptedBrain } from './scripted.js';

export type BrainKind = 'scripted' | 'anthropic' | 'openai' | 'nearai';
export const BRAIN_KINDS: BrainKind[] = ['scripted', 'anthropic', 'openai', 'nearai'];

/** No --brain: first key found wins (Anthropic, OpenAI, NEAR AI), otherwise the offline scripted brain. */
export function autoBrain(env: Record<string, string | undefined>): BrainKind {
  if (env.ANTHROPIC_API_KEY) return 'anthropic';
  if (env.OPENAI_API_KEY) return 'openai';
  if (env.NEAR_AI_API_KEY) return 'nearai';
  return 'scripted';
}

export async function makeBrain(kind: BrainKind, env: Record<string, string | undefined>, o: { vigilant?: boolean; model?: string } = {}): Promise<Brain> {
  const need = (k: string) => {
    const v = env[k];
    if (!v) throw new Error(`--brain ${kind} needs ${k}`);
    return v;
  };
  switch (kind) {
    case 'scripted':
      return new ScriptedBrain(!!o.vigilant);
    case 'anthropic': {
      const key = need('ANTHROPIC_API_KEY');
      return new AnthropicBrain(key, o.model || env.ANTHROPIC_MODEL || (await pickAnthropicModel(key)));
    }
    case 'openai': {
      const key = need('OPENAI_API_KEY');
      return new OpenAICompatBrain('openai', OPENAI_BASE, key, o.model || env.OPENAI_MODEL || (await pickOpenAIModel(key)));
    }
    case 'nearai':
      return new OpenAICompatBrain('nearai', NEARAI_BASE, need('NEAR_AI_API_KEY'), o.model || env.NEAR_AI_MODEL || NEARAI_DEFAULT_MODEL);
  }
}
