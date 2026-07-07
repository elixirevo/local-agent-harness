import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/config.js';
import { createProvider } from '../src/providers/index.js';
import { MlxProvider } from '../src/providers/mlx.js';
import type { ChatChunk } from '../src/providers/types.js';
import { byteStream, collect, fetchMock, sseBody } from './helpers.js';

function sseResponse(events: Array<object | string>): Response {
  return new Response(byteStream(sseBody(events)), { status: 200 });
}

describe('MlxProvider', () => {
  it('reports Apple-MLX-appropriate capabilities', () => {
    const caps = new MlxProvider({ baseUrl: 'http://localhost:8081' }).capabilities();
    expect(caps.nativeToolCalls).toBe(true);
    expect(caps.grammar).toBe(false); // no guided decoding — compaction retry falls back to plain
    expect(caps.reportsCacheHits).toBe(true); // reports prompt_tokens_details.cached_tokens (verified live)
  });

  it('speaks the OpenAI-compatible wire at /v1', async () => {
    const events = [
      { choices: [{ index: 0, delta: { content: 'hi' } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      '[DONE]',
    ];
    const { fn, calls } = fetchMock(() => sseResponse(events));
    const p = new MlxProvider({ baseUrl: 'http://localhost:8081', fetchFn: fn });
    const chunks = await collect(p.chat({ model: 'm', messages: [{ role: 'user', content: 'q' }] }));
    expect(calls[0].url).toBe('http://localhost:8081/v1/chat/completions');
    const text = chunks.filter((c): c is { type: 'text'; text: string } => c.type === 'text').map((c) => c.text).join('');
    expect(text).toBe('hi');
    expect(chunks.at(-1)).toEqual({ type: 'done', stopReason: 'stop' } satisfies ChatChunk);
  });

  it('is wired into createProvider and the default config preset', () => {
    const config = loadConfig('/nonexistent');
    expect(config.providers.mlx).toEqual({ type: 'mlx', baseUrl: 'http://localhost:8081' });
    expect(createProvider('mlx', config.providers.mlx)).toBeInstanceOf(MlxProvider);
  });
});
