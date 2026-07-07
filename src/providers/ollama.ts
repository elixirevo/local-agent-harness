import { ndjsonLines } from '../util/stream.js';
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
  type Usage,
} from './types.js';

export interface OllamaOptions {
  baseUrl: string;
  /** How long the model stays loaded after a request (Ollama duration string). */
  keepAlive?: string;
  fetchFn?: FetchFn;
}

/**
 * Native /api/chat adapter. Preferred over Ollama's OpenAI-compat endpoint
 * because it exposes num_ctx (the default context is small and silently
 * truncates — fatal for an agent), keep_alive, the thinking field, and
 * prefill timing.
 *
 * Cache measurement: prompt_eval_count semantics VARY by model/engine in
 * Ollama 0.30 (verified empirically): an identical repeated request reported
 * the full count (52/52), while a growing agent conversation on llama3.2
 * reported deltas (1336→401→531). So the count is surfaced as promptTokens
 * on a best-effort basis, and prompt_eval_duration is the reliable cache-hit
 * signal — a warm prefix collapses prefill time in every observed case.
 */
export class OllamaProvider implements ProviderAdapter {
  readonly name = 'ollama';
  private readonly baseUrl: string;
  private readonly keepAlive: string;
  private readonly fetchFn: FetchFn;

  constructor(opts: OllamaOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.keepAlive = opts.keepAlive ?? '10m';
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  capabilities(): ProviderCaps {
    // reportsCacheHits false: no evaluated-vs-cached token split, only prefill timing.
    return { nativeToolCalls: true, grammar: true, tokenCount: false, reportsCacheHits: false };
  }

  async listModels(): Promise<string[]> {
    const res = await this.fetchFn(`${this.baseUrl}/api/tags`, {});
    if (!res.ok) throw await ProviderError.fromResponse(this.name, res);
    const json = (await res.json()) as { models?: Array<{ name: string }> };
    return (json.models ?? []).map((m) => m.name);
  }

  async *chat(req: ChatRequest): AsyncIterable<ChatChunk> {
    let res = await this.request(req, /* withThink */ true);
    if (!res.ok) {
      const err = await ProviderError.fromResponse(this.name, res);
      // Models whose template lacks thinking support reject the think flag
      // (and gpt-oss expects string levels). Retry once without it — thinking
      // models still emit the thinking field by default.
      if (res.status === 400 && /think/i.test(err.message)) {
        res = await this.request(req, false);
        if (!res.ok) throw await ProviderError.fromResponse(this.name, res);
      } else {
        throw err;
      }
    }
    if (!res.body) throw new ProviderError(`${this.name}: empty response body`, this.name);

    // Belt and braces: with think enabled Ollama parses tags into the thinking
    // field, so the filter sees no tags and passes text through untouched.
    const filter = req.thinking === 'tags' ? new ThinkTagStream() : null;
    let usage: Usage | undefined;
    let stopReason: StopReason = 'unknown';
    let sawToolCall = false;
    let callSeq = 0;

    for await (const line of ndjsonLines(res.body)) {
      let json: any;
      try {
        json = JSON.parse(line);
      } catch {
        continue;
      }
      if (json.error) throw new ProviderError(`${this.name}: ${json.error}`, this.name);

      const msg = json.message;
      if (typeof msg?.thinking === 'string' && msg.thinking) {
        yield { type: 'thinking', text: msg.thinking };
      }
      if (typeof msg?.content === 'string' && msg.content) {
        if (filter) {
          for (const ev of filter.push(msg.content)) yield ev;
        } else {
          yield { type: 'text', text: msg.content };
        }
      }
      if (Array.isArray(msg?.tool_calls)) {
        for (const tc of msg.tool_calls) {
          if (!tc?.function?.name) continue;
          sawToolCall = true;
          yield {
            type: 'tool_call',
            call: {
              id: typeof tc.id === 'string' && tc.id ? tc.id : `call_${callSeq++}`,
              name: tc.function.name,
              // Ollama passes arguments as a parsed object; normalize to raw JSON.
              arguments: JSON.stringify(tc.function.arguments ?? {}),
            },
          };
        }
      }
      if (json.done) {
        usage = usageFromFinal(json);
        stopReason = mapDoneReason(json.done_reason, sawToolCall);
      }
    }

    if (filter) yield* filter.flush();
    if (usage) yield { type: 'usage', usage };
    yield { type: 'done', stopReason };
  }

  private request(req: ChatRequest, withThink: boolean): Promise<Response> {
    const options: Record<string, unknown> = {};
    if (req.contextLength !== undefined) options.num_ctx = req.contextLength;
    if (req.temperature !== undefined) options.temperature = req.temperature;
    if (req.maxTokens !== undefined) options.num_predict = req.maxTokens;

    const body: Record<string, unknown> = {
      model: req.model,
      messages: toOllamaMessages(req.messages),
      stream: true,
      options,
      keep_alive: this.keepAlive,
    };
    if (withThink && req.thinking && req.thinking !== 'none' && req.think !== undefined) {
      body.think = req.think;
    }
    if (req.format) body.format = req.format;
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }
    return this.fetchFn(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: req.signal ?? null,
    });
  }
}

function toOllamaMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((m) => {
    if (m.role === 'assistant' && m.toolCalls?.length) {
      return {
        role: 'assistant',
        content: m.content,
        tool_calls: m.toolCalls.map((tc) => ({
          function: { name: tc.name, arguments: safeParse(tc.arguments) },
        })),
      };
    }
    if (m.role === 'tool') {
      return { role: 'tool', content: m.content };
    }
    return { role: m.role, content: m.content };
  });
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return { _raw: raw };
  }
}

function usageFromFinal(json: any): Usage {
  const u: Usage = {};
  if (typeof json.prompt_eval_count === 'number') u.promptTokens = json.prompt_eval_count;
  if (typeof json.eval_count === 'number') u.completionTokens = json.eval_count;
  if (typeof json.prompt_eval_duration === 'number') u.promptMs = json.prompt_eval_duration / 1e6;
  if (typeof json.eval_duration === 'number') {
    u.completionMs = json.eval_duration / 1e6;
    if (typeof json.eval_count === 'number' && json.eval_duration > 0) {
      u.tokensPerSecond = json.eval_count / (json.eval_duration / 1e9);
    }
  }
  if (typeof json.load_duration === 'number') u.loadMs = json.load_duration / 1e6;
  return u;
}

function mapDoneReason(reason: unknown, sawToolCall: boolean): StopReason {
  if (sawToolCall) return 'tool_calls';
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
    default:
      return 'unknown';
  }
}
