import { OpenAICompatProvider, type OpenAICompatOptions } from './openaiCompat.js';
import type { ProviderCaps } from './types.js';

/**
 * Apple MLX adapter (mlx-lm's `mlx_lm.server`). Apple Silicon-native, unlike
 * vLLM which is CUDA-only — this is the second locally-verifiable provider
 * besides Ollama on a Mac. The wire is plain OpenAI-compatible, so this is a
 * thin subclass for discoverability and honest capability reporting.
 *
 * Native tool-call support is model- and version-dependent; the wire flag is
 * true and the ModelProfile / --protocol text decides per model. mlx-lm has
 * no guided-decoding parameter, so grammar is false (the compaction retry
 * falls back to the plain re-ask). It DOES report cached prompt tokens in
 * prompt_tokens_details (verified live: turn 2 of a chat showed cached 2364
 * of 2389) — a real prefix-cache-hit signal, unlike Ollama's.
 */
export class MlxProvider extends OpenAICompatProvider {
  constructor(opts: OpenAICompatOptions) {
    super({ name: 'mlx', ...opts });
  }

  override capabilities(): ProviderCaps {
    return { nativeToolCalls: true, grammar: false, tokenCount: false, reportsCacheHits: true };
  }
}
