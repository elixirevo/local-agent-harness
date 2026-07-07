export function byteStream(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]));
      else controller.close();
    },
  });
}

/** Split a string into fixed-size pieces to exercise chunk-boundary handling. */
export function chunked(s: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}

export interface FetchCall {
  url: string;
  init: RequestInit | undefined;
  body: any;
}

/**
 * fetch stub that records calls and serves queued responses. Response factories
 * (not instances) because stream bodies are single-use.
 */
export function fetchMock(...responses: Array<() => Response>): {
  fn: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  let i = 0;
  const fn = (async (url: unknown, init?: RequestInit) => {
    calls.push({
      url: String(url),
      init,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    const factory = responses[Math.min(i++, responses.length - 1)];
    if (!factory) throw new Error('fetchMock: no response queued');
    return factory();
  }) as typeof fetch;
  return { fn, calls };
}

export function sseBody(events: Array<object | string>, chunkSize?: number): string[] {
  const raw = events
    .map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`)
    .join('');
  return chunkSize ? chunked(raw, chunkSize) : [raw];
}

export function ndjsonBody(lines: object[], chunkSize?: number): string[] {
  const raw = lines.map((l) => `${JSON.stringify(l)}\n`).join('');
  return chunkSize ? chunked(raw, chunkSize) : [raw];
}

export async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iter) out.push(item);
  return out;
}
