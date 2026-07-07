import type { ProviderConfig } from '../config/config.js';
import { LlamaCppProvider } from './llamacpp.js';
import { MlxProvider } from './mlx.js';
import { OllamaProvider } from './ollama.js';
import { OpenAICompatProvider } from './openaiCompat.js';
import type { ProviderAdapter } from './types.js';
import { VllmProvider } from './vllm.js';

export function createProvider(name: string, cfg: ProviderConfig): ProviderAdapter {
  switch (cfg.type) {
    case 'ollama':
      return new OllamaProvider({ baseUrl: cfg.baseUrl, keepAlive: cfg.keepAlive });
    case 'llamacpp':
      return new LlamaCppProvider({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey });
    case 'vllm':
      return new VllmProvider({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey });
    case 'mlx':
      return new MlxProvider({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey });
    case 'openai-compat':
      return new OpenAICompatProvider({ name, baseUrl: cfg.baseUrl, apiKey: cfg.apiKey });
  }
}

export * from './types.js';
