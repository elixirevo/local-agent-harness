import fs from 'node:fs';
import path from 'node:path';
import type { ModelProfile, ResolvedProfile } from '../models/profile.js';
import type { PermissionMode } from '../permissions/gate.js';

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
  /** Set only by the user (file or --system); when absent the CLI picks an agent/chat default. */
  systemPrompt?: string;
  permissionMode: PermissionMode;
  /** Model steps allowed per user turn before the loop guard stops. */
  maxSteps: number;
  /** Persist conversations to .harness/sessions/*.jsonl (resume with --resume). */
  saveSessions: boolean;
  /** Profile overrides keyed by exact model id or family name. */
  models?: Record<string, Partial<ModelProfile>>;
}

/**
 * Chat-only fallback (models without native tool calls). Deliberately static —
 * no date, no cwd — so the prompt prefix is byte-identical across sessions
 * (prefix-cache friendly).
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
  permissionMode: 'ask',
  maxSteps: 20,
  saveSessions: true,
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
