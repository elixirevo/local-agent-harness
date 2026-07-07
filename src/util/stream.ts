/**
 * Byte-stream parsers for the two wire formats used by local LLM servers:
 * SSE (`data: {...}\n\n`, OpenAI-compatible endpoints) and NDJSON (Ollama native).
 * Both must tolerate JSON objects split across arbitrary chunk boundaries.
 */

/** Parse an SSE byte stream, yielding each event's `data:` payload as a string. */
export async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  let buf = '';
  for await (const piece of textPieces(body)) {
    buf += piece;
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const data = extractData(raw);
      if (data !== null) yield data;
    }
  }
  if (buf.trim()) {
    const data = extractData(buf);
    if (data !== null) yield data;
  }
}

function extractData(rawEvent: string): string | null {
  const lines = rawEvent.split('\n').filter((l) => l.startsWith('data:'));
  if (lines.length === 0) return null;
  // Per SSE spec, multiple data lines in one event are joined with newlines.
  return lines.map((l) => l.slice(5).replace(/^ /, '')).join('\n');
}

/** Parse a newline-delimited JSON byte stream, yielding each non-empty line. */
export async function* ndjsonLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  let buf = '';
  for await (const piece of textPieces(body)) {
    buf += piece;
    let idx: number;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line) yield line;
    }
  }
  const tail = buf.trim();
  if (tail) yield tail;
}

/** Decode bytes to text, normalizing \r\n to \n even when the pair is split across chunks. */
async function* textPieces(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let heldCR = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      let text = decoder.decode(value, { stream: true });
      if (heldCR) {
        text = '\r' + text;
        heldCR = false;
      }
      if (text.endsWith('\r')) {
        heldCR = true;
        text = text.slice(0, -1);
      }
      if (text) yield text.replace(/\r\n/g, '\n');
    }
    const rest = (heldCR ? '\r' : '') + decoder.decode();
    if (rest) yield rest.replace(/\r\n/g, '\n');
  } finally {
    reader.releaseLock();
  }
}
