import { sseEvents } from '../util/stream.js';
import { ThinkTagStream } from '../util/thinkFilter.js';
import {
  ProviderError,
  type ChatChunk,
  type ChatMessage,
  type ChatRequest,
  type FetchFn,
  type ProviderAdapter,
  type ProviderCaps,
  type StopReason,
  type ToolCall,
  type Usage,
} from './types.js';

export interface OpenAICompatOptions {
  name?: string;
  /** Server root (e.g. http://localhost:8080). "/v1" is appended unless already present. */
  baseUrl: string;
  apiKey?: string;
  fetchFn?: FetchFn;
}

/**
 * Adapter for any OpenAI-compatible /v1/chat/completions server — the common
 * denominator across Ollama, llama.cpp and vLLM. Provider-specific adapters
 * extend this (extra body fields, richer usage reporting) or replace it
 * entirely (Ollama native).
 */
export class OpenAICompatProvider implements ProviderAdapter {
  readonly name: string;
  protected readonly root: string;
  protected readonly apiKey: string | undefined;
  protected readonly fetchFn: FetchFn;

  constructor(opts: OpenAICompatOptions) {
    this.name = opts.name ?? 'openai-compat';
    this.root = opts.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
    this.apiKey = opts.apiKey;
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  protected openaiRoot(): string {
    return `${this.root}/v1`;
  }

  capabilities(): ProviderCaps {
    return { nativeToolCalls: true, grammar: false, tokenCount: false, reportsCacheHits: false };
  }

  async listModels(): Promise<string[]> {
    const res = await this.fetchFn(`${this.openaiRoot()}/models`, { headers: this.headers() });
    if (!res.ok) throw await ProviderError.fromResponse(this.name, res);
    const json = (await res.json()) as { data?: Array<{ id: string }> };
    return (json.data ?? []).map((m) => m.id);
  }

  async *chat(req: ChatRequest): AsyncIterable<ChatChunk> {
    const body = this.buildBody(req);
    const res = await this.fetchFn(`${this.openaiRoot()}/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: req.signal ?? null,
    });
    if (!res.ok || !res.body) throw await ProviderError.fromResponse(this.name, res);

    // Models that inline reasoning as text tags need splitting; servers that
    // already separate it (reasoning_content) simply never trigger the filter.
    const filter = req.thinking === 'tags' ? new ThinkTagStream() : null;
    const assembler = new ToolCallAssembler();
    let usage: Usage | undefined;
    let stopReason: StopReason = 'unknown';

    for await (const data of sseEvents(res.body)) {
      if (data === '[DONE]') break;
      let json: any;
      try {
        json = JSON.parse(data);
      } catch {
        continue; // tolerate keep-alive noise from lenient servers
      }
      usage = this.mergeUsage(usage, json);
      const choice = json.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};
      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (typeof reasoning === 'string' && reasoning) {
        yield { type: 'thinking', text: reasoning };
      }
      if (typeof delta.content === 'string' && delta.content) {
        if (filter) {
          for (const ev of filter.push(delta.content)) yield ev;
        } else {
          yield { type: 'text', text: delta.content };
        }
      }
      if (Array.isArray(delta.tool_calls)) assembler.push(delta.tool_calls);
      if (choice.finish_reason) stopReason = mapFinishReason(choice.finish_reason);
    }

    if (filter) yield* filter.flush();
    for (const call of assembler.finish()) yield { type: 'tool_call', call };
    if (usage) yield { type: 'usage', usage };
    yield { type: 'done', stopReason };
  }

  protected headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
    };
  }

  protected buildBody(req: ChatRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: toOpenAIMessages(req.messages),
      stream: true,
      stream_options: { include_usage: true },
    };
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }
    return this.extendBody(body, req);
  }

  /** Hook for subclasses to add provider-specific body fields. */
  protected extendBody(body: Record<string, unknown>, _req: ChatRequest): Record<string, unknown> {
    return body;
  }

  /** Fold usage info out of a stream chunk. Also reads llama.cpp's `timings` extension. */
  protected mergeUsage(current: Usage | undefined, json: any): Usage | undefined {
    let u = current;
    const raw = json.usage;
    if (raw && typeof raw === 'object') {
      u = { ...u };
      if (typeof raw.prompt_tokens === 'number') u.promptTokens = raw.prompt_tokens;
      if (typeof raw.completion_tokens === 'number') u.completionTokens = raw.completion_tokens;
      const cached = raw.prompt_tokens_details?.cached_tokens;
      if (typeof cached === 'number') u.cachedTokens = cached;
    }
    const t = json.timings;
    if (t && typeof t === 'object') {
      u = { ...u };
      if (typeof t.prompt_n === 'number') u.promptEvalTokens = t.prompt_n;
      if (typeof t.prompt_ms === 'number') u.promptMs = t.prompt_ms;
      if (typeof t.predicted_ms === 'number') u.completionMs = t.predicted_ms;
      if (typeof t.predicted_per_second === 'number') u.tokensPerSecond = t.predicted_per_second;
      if (typeof t.cache_n === 'number') u.cachedTokens = t.cache_n;
    }
    return u;
  }
}

function toOpenAIMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((m) => {
    if (m.role === 'assistant' && m.toolCalls?.length) {
      return {
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments },
        })),
      };
    }
    if (m.role === 'tool') {
      return { role: 'tool', content: m.content, tool_call_id: m.toolCallId };
    }
    return { role: m.role, content: m.content };
  });
}

function mapFinishReason(reason: string): StopReason {
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls';
    case 'length':
      return 'length';
    default:
      return 'unknown';
  }
}

/**
 * Assembles streamed tool-call fragments. OpenAI semantics: fragments carry an
 * `index`; `id`/`name` arrive once, `arguments` arrives as string pieces to
 * concatenate. Some servers send the whole call in a single fragment.
 */
class ToolCallAssembler {
  private calls: Array<{ id?: string; name: string; args: string }> = [];

  push(fragments: any[]): void {
    for (const f of fragments) {
      const i = typeof f.index === 'number' ? f.index : this.calls.length;
      while (this.calls.length <= i) this.calls.push({ name: '', args: '' });
      const c = this.calls[i];
      if (typeof f.id === 'string' && f.id) c.id = f.id;
      if (typeof f.function?.name === 'string' && f.function.name && !c.name) c.name = f.function.name;
      if (typeof f.function?.arguments === 'string') c.args += f.function.arguments;
    }
  }

  finish(): ToolCall[] {
    return this.calls
      .filter((c) => c.name)
      .map((c, i) => ({ id: c.id ?? `call_${i}`, name: c.name, arguments: c.args }));
  }
}
