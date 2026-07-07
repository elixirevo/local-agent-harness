import { describe, expect, it } from 'vitest';
import { LlamaCppProvider } from '../src/providers/llamacpp.js';
import { OpenAICompatProvider } from '../src/providers/openaiCompat.js';
import { ProviderError, type ChatChunk } from '../src/providers/types.js';
import { byteStream, collect, fetchMock, sseBody } from './helpers.js';

const textOf = (chunks: ChatChunk[], type: 'text' | 'thinking') =>
  chunks.filter((c): c is { type: typeof type; text: string } => c.type === type).map((c) => c.text).join('');

function sseResponse(events: Array<object | string>, chunkSize?: number): Response {
  return new Response(byteStream(sseBody(events, chunkSize)), { status: 200 });
}

describe('OpenAICompatProvider', () => {
  it('sends an OpenAI-shaped request and appends /v1 once', async () => {
    const { fn, calls } = fetchMock(() => sseResponse(['[DONE]']));
    const p = new OpenAICompatProvider({ baseUrl: 'http://localhost:9999/v1', fetchFn: fn });
    await collect(
      p.chat({
        model: 'm1',
        messages: [
          { role: 'system', content: 'sys' },
          { role: 'user', content: 'hi' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'c1', name: 'read', arguments: '{"path":"a"}' }],
          },
          { role: 'tool', content: 'result', toolCallId: 'c1' },
        ],
        temperature: 0.2,
        tools: [{ name: 'read', description: 'reads', parameters: { type: 'object' } }],
      }),
    );
    expect(calls[0].url).toBe('http://localhost:9999/v1/chat/completions');
    const body = calls[0].body;
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.temperature).toBe(0.2);
    expect(body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } },
        ],
      },
      { role: 'tool', content: 'result', tool_call_id: 'c1' },
    ]);
    expect(body.tools[0].function.name).toBe('read');
  });

  it('streams text deltas and final usage, across split chunks', async () => {
    const events = [
      { choices: [{ index: 0, delta: { role: 'assistant', content: 'Hel' } }] },
      { choices: [{ index: 0, delta: { content: 'lo' } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      {
        choices: [],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 2,
          prompt_tokens_details: { cached_tokens: 90 },
        },
      },
      '[DONE]',
    ];
    const { fn } = fetchMock(() => sseResponse(events, 7));
    const p = new OpenAICompatProvider({ baseUrl: 'http://x', fetchFn: fn });
    const chunks = await collect(p.chat({ model: 'm', messages: [{ role: 'user', content: 'q' }] }));
    expect(textOf(chunks, 'text')).toBe('Hello');
    const usage = chunks.find((c) => c.type === 'usage');
    expect(usage).toEqual({
      type: 'usage',
      usage: { promptTokens: 100, completionTokens: 2, cachedTokens: 90 },
    });
    expect(chunks.at(-1)).toEqual({ type: 'done', stopReason: 'stop' });
  });

  it('assembles tool-call fragments in index order', async () => {
    const events = [
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: 'call_abc', type: 'function', function: { name: 'read_file', arguments: '' } },
              ],
            },
          },
        ],
      },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }] } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
      '[DONE]',
    ];
    const { fn } = fetchMock(() => sseResponse(events));
    const p = new OpenAICompatProvider({ baseUrl: 'http://x', fetchFn: fn });
    const chunks = await collect(p.chat({ model: 'm', messages: [{ role: 'user', content: 'q' }] }));
    expect(chunks.filter((c) => c.type === 'tool_call')).toEqual([
      { type: 'tool_call', call: { id: 'call_abc', name: 'read_file', arguments: '{"path":"a.ts"}' } },
    ]);
    expect(chunks.at(-1)).toEqual({ type: 'done', stopReason: 'tool_calls' });
  });

  it('splits tag-style reasoning into thinking events when asked', async () => {
    const events = [
      { choices: [{ index: 0, delta: { content: '<think>hm' } }] },
      { choices: [{ index: 0, delta: { content: 'm</think>Answer' } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      '[DONE]',
    ];
    const { fn } = fetchMock(() => sseResponse(events));
    const p = new OpenAICompatProvider({ baseUrl: 'http://x', fetchFn: fn });
    const chunks = await collect(
      p.chat({ model: 'm', messages: [{ role: 'user', content: 'q' }], thinking: 'tags' }),
    );
    expect(textOf(chunks, 'thinking')).toBe('hmm');
    expect(textOf(chunks, 'text')).toBe('Answer');
  });

  it('surfaces reasoning_content deltas as thinking', async () => {
    const events = [
      { choices: [{ index: 0, delta: { reasoning_content: 'pondering' } }] },
      { choices: [{ index: 0, delta: { content: 'Answer' } }] },
      '[DONE]',
    ];
    const { fn } = fetchMock(() => sseResponse(events));
    const p = new OpenAICompatProvider({ baseUrl: 'http://x', fetchFn: fn });
    const chunks = await collect(p.chat({ model: 'm', messages: [{ role: 'user', content: 'q' }] }));
    expect(textOf(chunks, 'thinking')).toBe('pondering');
    expect(textOf(chunks, 'text')).toBe('Answer');
  });

  it('throws ProviderError with status on HTTP failure', async () => {
    const { fn } = fetchMock(() => new Response('{"error":"boom"}', { status: 500 }));
    const p = new OpenAICompatProvider({ baseUrl: 'http://x', fetchFn: fn });
    await expect(
      collect(p.chat({ model: 'm', messages: [{ role: 'user', content: 'q' }] })),
    ).rejects.toMatchObject({ name: 'ProviderError', status: 500 });
  });

  it('lists model ids', async () => {
    const { fn, calls } = fetchMock(
      () => new Response(JSON.stringify({ data: [{ id: 'a' }, { id: 'b' }] }), { status: 200 }),
    );
    const p = new OpenAICompatProvider({ baseUrl: 'http://x', fetchFn: fn });
    expect(await p.listModels()).toEqual(['a', 'b']);
    expect(calls[0].url).toBe('http://x/v1/models');
  });
});

describe('LlamaCppProvider', () => {
  it('forces cache_prompt and reads the timings extension into usage', async () => {
    const events = [
      { choices: [{ index: 0, delta: { content: 'Hi' } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      {
        choices: [],
        usage: { prompt_tokens: 100, completion_tokens: 5 },
        timings: {
          prompt_n: 20,
          prompt_ms: 50.5,
          predicted_ms: 100.2,
          predicted_per_second: 49.9,
          cache_n: 80,
        },
      },
      '[DONE]',
    ];
    const { fn, calls } = fetchMock(() => sseResponse(events));
    const p = new LlamaCppProvider({ baseUrl: 'http://localhost:8080', fetchFn: fn });
    const chunks = await collect(p.chat({ model: 'm', messages: [{ role: 'user', content: 'q' }] }));
    expect(calls[0].body.cache_prompt).toBe(true);
    const usage = chunks.find((c) => c.type === 'usage');
    expect(usage).toEqual({
      type: 'usage',
      usage: {
        promptTokens: 100,
        completionTokens: 5,
        promptEvalTokens: 20,
        promptMs: 50.5,
        completionMs: 100.2,
        tokensPerSecond: 49.9,
        cachedTokens: 80,
      },
    });
  });

  it('counts tokens via /tokenize on the server root', async () => {
    const { fn, calls } = fetchMock(
      () => new Response(JSON.stringify({ tokens: [1, 2, 3] }), { status: 200 }),
    );
    const p = new LlamaCppProvider({ baseUrl: 'http://localhost:8080', fetchFn: fn });
    expect(await p.countTokens('abc')).toBe(3);
    expect(calls[0].url).toBe('http://localhost:8080/tokenize');
  });
});
