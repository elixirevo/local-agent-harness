import { OpenAICompatProvider, type OpenAICompatOptions } from './openaiCompat.js';
import { ProviderError, type ChatRequest, type ProviderCaps } from './types.js';

/**
 * llama-server adapter. OpenAI-compatible wire plus llama.cpp extras:
 * explicit cache_prompt, /tokenize for exact token counts, and the `timings`
 * extension in stream chunks (parsed by the base class) for cache metrics.
 * Requires the server to run with --jinja for native tool-call templating.
 */
export class LlamaCppProvider extends OpenAICompatProvider {
  constructor(opts: OpenAICompatOptions) {
    super({ name: 'llamacpp', ...opts });
  }

  override capabilities(): ProviderCaps {
    return { nativeToolCalls: true, grammar: true, tokenCount: true, reportsCacheHits: true };
  }

  protected override extendBody(
    body: Record<string, unknown>,
    _req: ChatRequest,
  ): Record<string, unknown> {
    // Default in recent builds, but the whole harness depends on it — be explicit.
    body.cache_prompt = true;
    body.timings_per_token = false;
    return body;
  }

  async countTokens(text: string): Promise<number> {
    const res = await this.fetchFn(`${this.root}/tokenize`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ content: text, add_special: false }),
    });
    if (!res.ok) throw await ProviderError.fromResponse(this.name, res);
    const json = (await res.json()) as { tokens?: unknown[] };
    return json.tokens?.length ?? 0;
  }
}
