export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON string of the arguments exactly as the model produced them. */
  arguments: string;
}

export interface ChatMessage {
  role: Role;
  content: string;
  /** Reasoning text. Kept for display only — never serialized back to a provider. */
  thinking?: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
}

export type ThinkingMode = 'none' | 'tags' | 'field';

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  temperature?: number;
  maxTokens?: number;
  /** Requested context window (sent as num_ctx on Ollama). */
  contextLength?: number;
  /** How this model expresses reasoning; drives parsing/stripping. */
  thinking?: ThinkingMode;
  /** Enable/disable reasoning where the provider supports toggling it. */
  think?: boolean;
  /**
   * JSON Schema to constrain the output (grammar enforcement). Honored by
   * providers whose capabilities() report grammar: Ollama format, llama.cpp
   * json_schema, vLLM guided_json. Others ignore it.
   */
  format?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface Usage {
  /** Total prompt tokens for this call, if the provider reports it. */
  promptTokens?: number;
  /**
   * Prompt tokens actually (re)computed this call — the prefix-cache miss size.
   * On a warm cache this should be roughly "new tokens since last turn".
   */
  promptEvalTokens?: number;
  /** Prompt tokens served from cache, if the provider reports it. */
  cachedTokens?: number;
  completionTokens?: number;
  promptMs?: number;
  completionMs?: number;
  loadMs?: number;
  tokensPerSecond?: number;
}

export type StopReason = 'stop' | 'tool_calls' | 'length' | 'aborted' | 'unknown';

export type ChatChunk =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'usage'; usage: Usage }
  | { type: 'done'; stopReason: StopReason };

export interface ProviderCaps {
  /** Wire-level tool-call support (whether a given model handles it is the ModelProfile's call). */
  nativeToolCalls: boolean;
  /** Constrained output: GBNF / JSON-schema / guided decoding. */
  grammar: boolean;
  tokenCount: boolean;
  reportsCacheHits: boolean;
}

export interface ProviderAdapter {
  readonly name: string;
  chat(req: ChatRequest): AsyncIterable<ChatChunk>;
  capabilities(): ProviderCaps;
  listModels(): Promise<string[]>;
  countTokens?(text: string): Promise<number>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }

  static async fromResponse(provider: string, res: Response): Promise<ProviderError> {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 500);
    } catch {
      // body already consumed or unavailable
    }
    return new ProviderError(
      `${provider}: HTTP ${res.status}${detail ? ` — ${detail}` : ''}`,
      provider,
      res.status,
    );
  }
}

export type FetchFn = typeof fetch;
