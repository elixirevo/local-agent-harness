import { OpenAICompatProvider, type OpenAICompatOptions } from './openaiCompat.js';
import type { ProviderCaps } from './types.js';

/**
 * vLLM adapter. Pure OpenAI-compatible wire for now; reports cache hits via
 * prompt_tokens_details.cached_tokens when Automatic Prefix Caching is on.
 * Native tool calls require the server to run with --enable-auto-tool-choice
 * and a --tool-call-parser matching the model. Guided decoding (guided_json /
 * guided_grammar) hooks in here in Phase 2.
 */
export class VllmProvider extends OpenAICompatProvider {
  constructor(opts: OpenAICompatOptions) {
    super({ name: 'vllm', ...opts });
  }

  override capabilities(): ProviderCaps {
    return { nativeToolCalls: true, grammar: true, tokenCount: false, reportsCacheHits: true };
  }
}
