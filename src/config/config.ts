import fs from 'node:fs';
import path from 'node:path';
import type { ModelProfile, ResolvedProfile } from '../models/profile.js';

export interface ProviderConfig {
  type: 'ollama' | 'llamacpp' | 'vllm' | 'openai-compat';
  baseUrl: string;
  apiKey?: string;
  keepAlive?: string;
}

export interface HarnessConfig {
  defaultProvider: string;
  defaultModel?: string;
  providers: Record<string, ProviderConfig>;
  /** VRAM guard: effective num_ctx = min(profile.contextLength, this). */
  contextLength: number;
  systemPrompt: string;
  /** Profile overrides keyed by exact model id or family name. */
  models?: Record<string, Partial<ModelProfile>>;
}

/**
 * Phase 0 placeholder. Deliberately static — no date, no cwd — so the prompt
 * prefix is byte-identical across turns and sessions (prefix-cache friendly).
 * Phase 2 replaces this with tiered section assembly behind a dynamic boundary.
 */
export const DEFAULT_SYSTEM_PROMPT =
  'You are a helpful assistant running on a locally hosted model. Be direct and concise.';

const DEFAULTS: HarnessConfig = {
  defaultProvider: 'ollama',
  providers: {
    ollama: { type: 'ollama', baseUrl: 'http://localhost:11434' },
    llamacpp: { type: 'llamacpp', baseUrl: 'http://localhost:8080' },
    vllm: { type: 'vllm', baseUrl: 'http://localhost:8000' },
  },
  contextLength: 32768,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
};

export const CONFIG_FILENAME = 'harness.config.json';

/** Load config from ./harness.config.json when present, merged over defaults. */
export function loadConfig(cwd: string = process.cwd()): HarnessConfig {
  const file = path.join(cwd, CONFIG_FILENAME);
  if (!fs.existsSync(file)) return structuredClone(DEFAULTS);
  let user: Partial<HarnessConfig>;
  try {
    user = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`Failed to parse ${file}: ${(e as Error).message}`);
  }
  const merged: HarnessConfig = {
    ...structuredClone(DEFAULTS),
    ...user,
    providers: { ...structuredClone(DEFAULTS.providers), ...(user.providers ?? {}) },
  };
  if (!merged.providers[merged.defaultProvider]) {
    throw new Error(
      `defaultProvider "${merged.defaultProvider}" is not defined in providers (${Object.keys(merged.providers).join(', ')})`,
    );
  }
  return merged;
}

export function effectiveContextLength(profile: ResolvedProfile, config: HarnessConfig): number {
  return Math.min(profile.contextLength, config.contextLength);
}
