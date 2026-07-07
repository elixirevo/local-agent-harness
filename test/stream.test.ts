import { describe, expect, it } from 'vitest';
import { ndjsonLines, sseEvents } from '../src/util/stream.js';
import { byteStream, chunked, collect } from './helpers.js';

describe('sseEvents', () => {
  it('parses consecutive events', async () => {
    const body = 'data: {"a":1}\n\ndata: {"b":2}\n\ndata: [DONE]\n\n';
    expect(await collect(sseEvents(byteStream([body])))).toEqual(['{"a":1}', '{"b":2}', '[DONE]']);
  });

  it('handles events split across arbitrary chunk boundaries', async () => {
    const body = 'data: {"text":"hello world"}\n\ndata: {"text":"second"}\n\n';
    for (const size of [1, 3, 7]) {
      expect(await collect(sseEvents(byteStream(chunked(body, size))))).toEqual([
        '{"text":"hello world"}',
        '{"text":"second"}',
      ]);
    }
  });

  it('normalizes CRLF, including a pair split across chunks', async () => {
    expect(
      await collect(sseEvents(byteStream(['data: {"a":1}\r', '\n\r\ndata: {"b":2}\r\n\r\n']))),
    ).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('joins multi-line data fields per SSE spec', async () => {
    expect(await collect(sseEvents(byteStream(['data: line1\ndata: line2\n\n'])))).toEqual([
      'line1\nline2',
    ]);
  });

  it('ignores comments and event fields without data', async () => {
    expect(
      await collect(sseEvents(byteStream([': keepalive\n\nevent: ping\n\ndata: x\n\n']))),
    ).toEqual(['x']);
  });

  it('flushes a final event missing its trailing blank line', async () => {
    expect(await collect(sseEvents(byteStream(['data: {"a":1}'])))).toEqual(['{"a":1}']);
  });
});

describe('ndjsonLines', () => {
  it('parses lines split across chunks', async () => {
    const body = '{"a":1}\n{"b":2}\n{"c":3}\n';
    for (const size of [1, 4, 9]) {
      expect(await collect(ndjsonLines(byteStream(chunked(body, size))))).toEqual([
        '{"a":1}',
        '{"b":2}',
        '{"c":3}',
      ]);
    }
  });

  it('skips blank lines and flushes an unterminated tail', async () => {
    expect(await collect(ndjsonLines(byteStream(['{"a":1}\n\n{"b":2}'])))).toEqual([
      '{"a":1}',
      '{"b":2}',
    ]);
  });
});
