import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { PromptTier } from '../models/profile.js';
import { err, type Tool, type ToolResult } from './types.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_REDIRECTS = 5;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 30_000;
const HEAD_CHARS = 15_000;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const BINARY_TYPES = /^(image|audio|video|font)\/|application\/(octet-stream|pdf|zip|gzip|x-tar|wasm)/i;

export type LookupFn = (hostname: string) => Promise<string[]>;

const dnsLookup: LookupFn = async (hostname) => {
  const addrs = await lookup(hostname, { all: true });
  return addrs.map((a) => a.address);
};

/**
 * SSRF guard: only public http(s) endpoints. Loopback, private-range,
 * link-local, CGNAT, multicast and unspecified addresses are all blocked —
 * both as IP literals and after DNS resolution — so the model cannot probe
 * localhost services (the provider server, MCP ports) or cloud metadata
 * endpoints (169.254.169.254).
 */
export function isPrivateAddress(addr: string): boolean {
  const ip = addr.toLowerCase();
  if (isIP(ip) === 4) return isPrivateV4(ip);
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (mapped) return isPrivateV4(mapped[1]);
  // '::' (unspecified), '::1' (loopback), and v4-compatible '::x.x.x.x'.
  if (ip.startsWith('::')) return true;
  const first = ip.split(':', 1)[0];
  if (/^f[cd]/.test(first)) return true; // fc00::/7 unique-local
  if (/^fe[89ab]/.test(first)) return true; // fe80::/10 link-local
  return false;
}

function isPrivateV4(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

/** Parse and validate a URL for fetching; throws with a model-facing reason. */
export async function guardUrl(raw: string, lookupFn: LookupFn = dnsLookup): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`invalid URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`unsupported protocol "${url.protocol}" — only http and https URLs can be fetched`);
  }
  if (url.username || url.password) {
    throw new Error('URLs with embedded credentials are not allowed');
  }
  const host = url.hostname.replace(/^\[|\]$/g, ''); // [::1] → ::1
  let addrs: string[];
  if (isIP(host)) {
    addrs = [host];
  } else {
    try {
      addrs = await lookupFn(host);
    } catch {
      throw new Error(`could not resolve host: ${host}`);
    }
  }
  for (const a of addrs) {
    if (isPrivateAddress(a)) {
      throw new Error(`blocked: ${host} points to a private/loopback address (${a}) — only public hosts can be fetched`);
    }
  }
  return url;
}

/** Convert an HTML document to readable plain text (title + body text). */
export function htmlToText(html: string): string {
  let s = html
    .replace(/<script[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(s)?.[1]?.trim();
  s = s
    .replace(/<head[\s\S]*?<\/head\s*>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/section|\/article|\/tr|\/h[1-6]|\/ul|\/ol|\/blockquote|\/pre|\/table)[^>]*>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  const lines = s.split('\n').map((l) => l.replace(/[ \t\u00a0]+/g, ' ').trim());
  const out: string[] = [];
  for (const line of lines) {
    if (line === '' && out[out.length - 1] === '') continue;
    out.push(line);
  }
  const text = out.join('\n').trim();
  const decodedTitle = title ? decodeEntities(title).replace(/\s+/g, ' ') : '';
  return decodedTitle ? `# ${decodedTitle}\n\n${text}` : text;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  hellip: '…', mdash: '—', ndash: '–', copy: '©', middot: '·',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, code: string) => {
    if (code.startsWith('#')) {
      const n = /^#x/i.test(code) ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? m;
  });
}

export interface WebFetchResult {
  /** Final URL after redirects. */
  url: string;
  status: number;
  contentType: string;
  text: string;
  /** True when the body hit the byte cap and was cut off. */
  capped: boolean;
}

export interface FetchWebOptions {
  timeoutMs?: number;
  lookupFn?: LookupFn;
  fetchFn?: typeof fetch;
  maxBodyBytes?: number;
}

/**
 * GET a public URL with manual redirect handling — every hop goes back
 * through guardUrl so a public page cannot bounce the request to a private
 * address. The body is read with a byte cap; HTML becomes plain text.
 */
export async function fetchWeb(raw: string, opts: FetchWebOptions = {}): Promise<WebFetchResult> {
  const timeoutMs = Math.min(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const fetchFn = opts.fetchFn ?? fetch;
  const maxBody = opts.maxBodyBytes ?? MAX_BODY_BYTES;
  let url = await guardUrl(raw, opts.lookupFn);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    for (let hop = 0; ; hop++) {
      const res = await fetchFn(url, {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'user-agent': 'agent-harness (local LLM agent)',
          accept: 'text/html, text/*;q=0.9, application/json;q=0.8, */*;q=0.1',
        },
      });
      const location = res.headers.get('location');
      if (REDIRECT_STATUSES.has(res.status) && location) {
        await res.body?.cancel().catch(() => {});
        if (hop >= MAX_REDIRECTS) throw new Error(`too many redirects (more than ${MAX_REDIRECTS})`);
        url = await guardUrl(new URL(location, url).toString(), opts.lookupFn);
        continue;
      }
      const contentType = res.headers.get('content-type') ?? '';
      if (BINARY_TYPES.test(contentType)) {
        await res.body?.cancel().catch(() => {});
        throw new Error(`unsupported binary content-type: ${contentType}`);
      }
      const { text: body, capped } = await readBody(res, maxBody);
      const isHtml =
        /text\/html|application\/xhtml/i.test(contentType) ||
        (contentType === '' && /^\s*(<!doctype html|<html)/i.test(body));
      return {
        url: url.toString(),
        status: res.status,
        contentType: contentType.split(';')[0].trim(),
        text: isHtml ? htmlToText(body) : body,
        capped,
      };
    }
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new Error(`fetch timed out after ${timeoutMs}ms`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function readBody(res: Response, cap: number): Promise<{ text: string; capped: boolean }> {
  if (!res.body) return { text: await res.text(), capped: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let capped = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    if (size >= cap) {
      capped = true;
      await reader.cancel().catch(() => {});
      break;
    }
  }
  return { text: Buffer.concat(chunks).toString('utf8'), capped };
}

export const webFetchTool: Tool = {
  name: 'WebFetch',
  isReadOnly: true, // GET only, public hosts only — gated like other reads
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Full http(s) URL to fetch' },
      timeout: { type: 'integer', description: `Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS})` },
    },
    required: ['url'],
  },

  description(tier: PromptTier): string {
    if (tier === 'minimal') {
      return 'Fetch a public http(s) URL with GET and return its text. HTML is converted to plain text. To search the web, fetch https://html.duckduckgo.com/html/?q=<url-encoded query> and then fetch a result URL.';
    }
    return [
      'Fetches a public http(s) URL with a GET request and returns the response as text.',
      '- HTML pages are converted to plain text (scripts and styles stripped); JSON and other text types are returned as-is.',
      '- To SEARCH the web (current events, facts you do not know), fetch https://html.duckduckgo.com/html/?q=<url-encoded query>. The results are only titles, URLs, and snippets — do NOT answer from them alone; pick the best result URL, fetch THAT page, and answer from its content.',
      '- Weather shortcut: fetch https://wttr.in/<City>?format=3 for one-line current weather (append &lang=ko for Korean; use format=v2 for a forecast).',
      '- JavaScript-only pages (google.com search, SPAs) return little or no text — prefer the DuckDuckGo endpoint above and static pages.',
      '- Only public hosts are reachable: private, loopback, and link-local addresses are blocked.',
      `- Redirects are followed (max ${MAX_REDIRECTS}); long responses are truncated to ${MAX_OUTPUT_CHARS} characters keeping the head and tail.`,
      '- Never put secrets or tokens in a URL.',
      `- Default timeout ${DEFAULT_TIMEOUT_MS / 1000}s; pass timeout (ms) for slow pages, max ${MAX_TIMEOUT_MS / 1000}s.`,
    ].join('\n');
  },

  summarize(input) {
    const url = String(input.url ?? '?');
    return url.length > 80 ? `${url.slice(0, 80)}…` : url;
  },

  async call(input): Promise<ToolResult> {
    const raw = String(input.url ?? '');
    const timeoutMs = typeof input.timeout === 'number' ? (input.timeout as number) : DEFAULT_TIMEOUT_MS;
    let result: WebFetchResult;
    try {
      result = await fetchWeb(raw, { timeoutMs });
    } catch (e) {
      return err(`WebFetch failed: ${(e as Error).message}`);
    }
    const body = truncateMiddle(result.text) || '(empty response)';
    const notes = [result.capped ? 'response hit the size cap and was cut off' : '', result.url !== raw ? `final URL: ${result.url}` : '']
      .filter(Boolean)
      .join('; ');
    // Small models answer from search snippets and stop; nudge the next hop.
    const searchNote = isSearchResultUrl(result.url)
      ? '\n\n<system-reminder>This is a search RESULTS page — titles, URLs, and snippets only. Do not answer from it. Pick the most relevant result URL, call WebFetch on it, and answer from that page\'s content.</system-reminder>'
      : '';
    return {
      ok: true, // non-2xx is information for the model, not a harness error
      output: `HTTP ${result.status}${notes ? ` (${notes})` : ''}\n\n${body}${searchNote}`,
      display: `HTTP ${result.status} · ${result.contentType || 'text'} · ${(result.text.length / 1000).toFixed(1)}k chars`,
    };
  },
};

/** True for search-engine result pages (the fetch is a hop, not an answer). */
function isSearchResultUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return /(^|\.)duckduckgo\.com$/.test(hostname);
  } catch {
    return false;
  }
}

/** Keep head and tail, like Bash output truncation. */
function truncateMiddle(s: string): string {
  if (s.length <= MAX_OUTPUT_CHARS) return s;
  const tail = MAX_OUTPUT_CHARS - HEAD_CHARS;
  return `${s.slice(0, HEAD_CHARS)}\n\n... (${s.length - MAX_OUTPUT_CHARS} characters omitted) ...\n\n${s.slice(-tail)}`;
}
