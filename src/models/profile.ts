import type { ThinkingMode } from '../providers/types.js';

export type PromptTier = 'minimal' | 'standard' | 'full';

export interface ModelProfile {
  family: string;
  /**
   * The model's native context window. The effective num_ctx sent to the
   * provider is capped separately by config (VRAM guard) — see config.ts.
   */
  contextLength: number;
  nativeToolCalls: boolean;
  parallelToolCalls: boolean;
  thinking: ThinkingMode;
  promptTier: PromptTier;
  temperature: number;
  notes?: string;
}

export interface ResolvedProfile extends ModelProfile {
  modelId: string;
}

/**
 * Built-in profiles, first match wins. Matched against the lowercased basename
 * of the model id, so both "qwen3:32b" (Ollama) and "Qwen/Qwen3-32B" (vLLM) hit.
 * Values from model cards as of 2026-07 — re-verify when adding entries.
 */
const PROFILES: Array<{ match: RegExp; profile: ModelProfile }> = [
  {
    match: /^qwen-?3/,
    profile: {
      family: 'qwen3',
      contextLength: 32768,
      nativeToolCalls: true,
      parallelToolCalls: false,
      thinking: 'tags',
      promptTier: 'standard',
      temperature: 0.6,
      notes: 'Hybrid thinking. Qwen recommends 0.6 in thinking mode; greedy decoding degrades reasoning.',
    },
  },
  {
    match: /^qwen-?2\.5-coder/,
    profile: {
      family: 'qwen2.5-coder',
      contextLength: 32768,
      nativeToolCalls: true,
      parallelToolCalls: false,
      thinking: 'none',
      promptTier: 'standard',
      temperature: 0.2,
    },
  },
  {
    match: /^deepseek-r1/,
    profile: {
      family: 'deepseek-r1',
      contextLength: 65536,
      nativeToolCalls: false,
      parallelToolCalls: false,
      thinking: 'tags',
      promptTier: 'minimal',
      temperature: 0.6,
      notes: 'Reasoning-only; unreliable at native tool calls — use the text protocol fallback (Phase 2).',
    },
  },
  {
    match: /^llama-?3\.[123]/,
    profile: {
      family: 'llama3',
      contextLength: 131072,
      nativeToolCalls: true,
      parallelToolCalls: false,
      thinking: 'none',
      promptTier: 'standard',
      temperature: 0.2,
    },
  },
  {
    match: /^devstral/,
    profile: {
      family: 'devstral',
      contextLength: 131072,
      nativeToolCalls: true,
      parallelToolCalls: false,
      thinking: 'none',
      promptTier: 'standard',
      temperature: 0.15,
      notes: 'Agent-tuned (OpenHands); Mistral recommends low temperature.',
    },
  },
  {
    match: /^mistral-small/,
    profile: {
      family: 'mistral-small',
      contextLength: 32768,
      nativeToolCalls: true,
      parallelToolCalls: false,
      thinking: 'none',
      promptTier: 'standard',
      temperature: 0.15,
    },
  },
  {
    match: /^gpt-oss/,
    profile: {
      family: 'gpt-oss',
      contextLength: 131072,
      nativeToolCalls: true,
      parallelToolCalls: false,
      thinking: 'field',
      promptTier: 'standard',
      temperature: 1.0,
      notes: 'Harmony reasoning channel; OpenAI recommends temperature 1.0.',
    },
  },
  {
    match: /^gemma-?4/,
    profile: {
      family: 'gemma4',
      contextLength: 131072,
      nativeToolCalls: true,
      parallelToolCalls: false,
      thinking: 'field',
      promptTier: 'standard',
      temperature: 1.0,
      notes: 'Verified via `ollama show` (0.30.x): tools + thinking capabilities. Gemma-family default temperature 1.0.',
    },
  },
  {
    match: /^gemma/,
    profile: {
      family: 'gemma',
      contextLength: 32768,
      nativeToolCalls: false,
      parallelToolCalls: false,
      thinking: 'none',
      promptTier: 'minimal',
      temperature: 1.0,
      notes: 'Gemma ≤3 — no tool template in Ollama. Verify per version with `ollama show`.',
    },
  },
  {
    match: /^kimi-k2/,
    profile: {
      family: 'kimi-k2',
      contextLength: 131072,
      nativeToolCalls: true,
      parallelToolCalls: false,
      thinking: 'none',
      promptTier: 'standard',
      temperature: 0.6,
      notes: 'Agentic MoE. K2.5 variants may add thinking — verify with `ollama show`.',
    },
  },
];

export const DEFAULT_PROFILE: ModelProfile = {
  family: 'unknown',
  contextLength: 8192,
  nativeToolCalls: false,
  parallelToolCalls: false,
  thinking: 'none',
  promptTier: 'minimal',
  temperature: 0.2,
  notes: 'Unrecognized model — conservative defaults. Add a built-in profile or a config override.',
};

/**
 * Resolve a model id to its profile. `overrides` (from config) are merged on
 * top, matched by exact model id first, then by family name.
 */
export function resolveProfile(
  modelId: string,
  overrides?: Record<string, Partial<ModelProfile>>,
): ResolvedProfile {
  const key = modelId.toLowerCase().split('/').pop() ?? modelId.toLowerCase();
  const base = PROFILES.find((p) => p.match.test(key))?.profile ?? DEFAULT_PROFILE;
  const override = overrides?.[modelId] ?? overrides?.[base.family];
  return { ...base, ...override, modelId };
}
