import { describe, expect, it } from 'vitest';
import { OllamaProvider } from '../src/providers/ollama.js';
import type { ChatChunk, ChatRequest } from '../src/providers/types.js';
import { byteStream, collect, fetchMock, ndjsonBody } from './helpers.js';

const textOf = (chunks: ChatChunk[], type: 'text' | 'thinking') =>
  chunks.filter((c): c is { type: typeof type; text: string } => c.type === type).map((c) => c.text).join('');

function ndjsonResponse(lines: object[], chunkSize?: number): Response {
  return new Response(byteStream(ndjsonBody(lines, chunkSize)), { status: 200 });
}

const baseReq: ChatRequest = {
  model: 'qwen3:8b',
  messages: [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
  ],
  temperature: 0.6,
  contextLength: 4096,
  thinking: 'tags',
  think: true,
};

describe('OllamaProvider', () => {
  it('sends num_ctx, temperature, keep_alive and think on the native endpoint', async () => {
    const { fn, calls } = fetchMock(() =>
      ndjsonResponse([{ message: { role: 'assistant', content: 'ok' }, done: true, done_reason: 'stop' }]),
    );
    const p = new OllamaProvider({ baseUrl: 'http://localhost:11434', keepAlive: '5m', fetchFn: fn });
    await collect(p.chat(baseReq));
    expect(calls[0].url).toBe('http://localhost:11434/api/chat');
    const body = calls[0].body;
    expect(body.options).toEqual({ num_ctx: 4096, temperature: 0.6 });
    expect(body.keep_alive).toBe('5m');
    expect(body.think).toBe(true);
    expect(body.stream).toBe(true);
  });

  it('passes a format schema through for grammar enforcement', async () => {
    const { fn, calls } = fetchMock(() =>
      ndjsonResponse([{ message: { role: 'assistant', content: '{}' }, done: true, done_reason: 'stop' }]),
    );
    const p = new OllamaProvider({ baseUrl: 'http://x', fetchFn: fn });
    const schema = { type: 'object', properties: { a: { type: 'string' } } };
    await collect(p.chat({ ...baseReq, format: schema }));
    expect(calls[0].body.format).toEqual(schema);
  });

  it('maps thinking/content fields and final counters to chunks', async () => {
    const lines = [
      { message: { role: 'assistant', thinking: 'Let me ' }, done: false },
      { message: { role: 'assistant', thinking: 'see.' }, done: false },
      { message: { role: 'assistant', content: 'Hel' }, done: false },
      { message: { role: 'assistant', content: 'lo' }, done: false },
      {
        message: { role: 'assistant', content: '' },
        done: true,
        done_reason: 'stop',
        load_duration: 1_000_000,
        prompt_eval_count: 42,
        prompt_eval_duration: 2_000_000,
        eval_count: 10,
        eval_duration: 500_000_000,
      },
    ];
    const { fn } = fetchMock(() => ndjsonResponse(lines, 13));
    const p = new OllamaProvider({ baseUrl: 'http://x', fetchFn: fn });
    const chunks = await collect(p.chat(baseReq));
    expect(textOf(chunks, 'thinking')).toBe('Let me see.');
    expect(textOf(chunks, 'text')).toBe('Hello');
    expect(chunks.find((c) => c.type === 'usage')).toEqual({
      type: 'usage',
      usage: {
        promptTokens: 42,
        completionTokens: 10,
        promptMs: 2,
        completionMs: 500,
        tokensPerSecond: 20,
        loadMs: 1,
      },
    });
    expect(chunks.at(-1)).toEqual({ type: 'done', stopReason: 'stop' });
  });

  it('normalizes object tool-call arguments to raw JSON strings', async () => {
    const lines = [
      {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ function: { name: 'read_file', arguments: { path: 'a.ts' } } }],
        },
        done: false,
      },
      { message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' },
    ];
    const { fn } = fetchMock(() => ndjsonResponse(lines));
    const p = new OllamaProvider({ baseUrl: 'http://x', fetchFn: fn });
    const chunks = await collect(p.chat(baseReq));
    expect(chunks.filter((c) => c.type === 'tool_call')).toEqual([
      { type: 'tool_call', call: { id: 'call_0', name: 'read_file', arguments: '{"path":"a.ts"}' } },
    ]);
    expect(chunks.at(-1)).toEqual({ type: 'done', stopReason: 'tool_calls' });
  });

  it('retries once without think when the model rejects it', async () => {
    const { fn, calls } = fetchMock(
      () => new Response(JSON.stringify({ error: 'model does not support thinking' }), { status: 400 }),
      () => ndjsonResponse([{ message: { role: 'assistant', content: 'ok' }, done: true, done_reason: 'stop' }]),
    );
    const p = new OllamaProvider({ baseUrl: 'http://x', fetchFn: fn });
    const chunks = await collect(p.chat(baseReq));
    expect(calls).toHaveLength(2);
    expect(calls[0].body.think).toBe(true);
    expect(calls[1].body.think).toBeUndefined();
    expect(textOf(chunks, 'text')).toBe('ok');
  });

  it('throws ProviderError on an in-stream error line', async () => {
    const { fn } = fetchMock(() => ndjsonResponse([{ error: 'model not found' }]));
    const p = new OllamaProvider({ baseUrl: 'http://x', fetchFn: fn });
    await expect(collect(p.chat(baseReq))).rejects.toMatchObject({
      name: 'ProviderError',
      message: 'ollama: model not found',
    });
  });

  it('serializes assistant tool calls back to object arguments', async () => {
    const { fn, calls } = fetchMock(() =>
      ndjsonResponse([{ message: { role: 'assistant', content: 'ok' }, done: true, done_reason: 'stop' }]),
    );
    const p = new OllamaProvider({ baseUrl: 'http://x', fetchFn: fn });
    await collect(
      p.chat({
        ...baseReq,
        messages: [
          { role: 'user', content: 'q' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'c1', name: 'read', arguments: '{"path":"a"}' }],
          },
          { role: 'tool', content: 'data', toolCallId: 'c1' },
        ],
      }),
    );
    expect(calls[0].body.messages[1]).toEqual({
      role: 'assistant',
      content: '',
      tool_calls: [{ function: { name: 'read', arguments: { path: 'a' } } }],
    });
    expect(calls[0].body.messages[2]).toEqual({ role: 'tool', content: 'data' });
  });
});
