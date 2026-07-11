import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchWeb,
  guardUrl,
  htmlToText,
  isPrivateAddress,
  webFetchTool,
  type LookupFn,
} from '../src/tools/webfetch.js';
import { byteStream, fetchMock } from './helpers.js';

// The tool's default lookup must never hit real DNS in tests; explicit
// lookupFn stubs below override this where a specific answer matters.
vi.mock('node:dns/promises', () => ({
  lookup: async () => [{ address: '93.184.216.34', family: 4 }],
}));

const publicLookup: LookupFn = async () => ['93.184.216.34'];
const privateLookup: LookupFn = async () => ['127.0.0.1'];

describe('isPrivateAddress', () => {
  it('blocks loopback, private ranges, link-local, CGNAT, multicast (v4)', () => {
    for (const ip of [
      '127.0.0.1', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1',
      '169.254.169.254', // cloud metadata
      '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255',
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it('allows public v4 addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '223.255.255.1']) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  it('blocks loopback, unique-local, link-local, and mapped-private (v6)', () => {
    for (const ip of ['::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:192.168.0.1']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it('allows public v6 addresses', () => {
    expect(isPrivateAddress('2606:4700::1111')).toBe(false);
    expect(isPrivateAddress('::ffff:8.8.8.8')).toBe(false);
  });
});

describe('guardUrl', () => {
  it('rejects non-http protocols, credentials, and malformed URLs', async () => {
    await expect(guardUrl('ftp://example.com/x')).rejects.toThrow(/only http and https/);
    await expect(guardUrl('file:///etc/passwd')).rejects.toThrow(/only http and https/);
    await expect(guardUrl('https://user:pw@example.com/')).rejects.toThrow(/credentials/);
    await expect(guardUrl('not a url')).rejects.toThrow(/invalid URL/);
  });

  it('rejects private IP literals without a DNS lookup', async () => {
    await expect(guardUrl('http://127.0.0.1:11434/api/tags')).rejects.toThrow(/private\/loopback/);
    await expect(guardUrl('http://[::1]:8080/')).rejects.toThrow(/private\/loopback/);
    await expect(guardUrl('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(/private\/loopback/);
  });

  it('resolves hostnames and rejects ones that point at private addresses', async () => {
    await expect(guardUrl('http://localhost:3000/', privateLookup)).rejects.toThrow(/private\/loopback/);
    await expect(guardUrl('https://example.com/docs', publicLookup)).resolves.toBeInstanceOf(URL);
  });

  it('reports unresolvable hosts', async () => {
    const failing: LookupFn = async () => {
      throw new Error('ENOTFOUND');
    };
    await expect(guardUrl('https://nope.invalid/', failing)).rejects.toThrow(/could not resolve/);
  });
});

describe('htmlToText', () => {
  it('strips scripts, styles, comments, and tags; keeps the title as a heading', () => {
    const html = `<html><head><title>My  Page</title><style>body{color:red}</style></head>
      <body><script>alert(1)</script><!-- hidden --><h1>Hello</h1><p>World &amp; friends</p></body></html>`;
    const text = htmlToText(html);
    expect(text.startsWith('# My Page')).toBe(true);
    expect(text).toContain('Hello');
    expect(text).toContain('World & friends');
    expect(text).not.toContain('alert');
    expect(text).not.toContain('color:red');
    expect(text).not.toContain('hidden');
  });

  it('renders list items as bullets and decodes entities', () => {
    const text = htmlToText('<ul><li>one&nbsp;a</li><li>&#8220;two&#8221;</li></ul>');
    expect(text).toContain('- one a');
    expect(text).toContain('- “two”');
  });

  it('collapses runs of blank lines', () => {
    const text = htmlToText('<p>a</p><div></div><div></div><p>b</p>');
    expect(text).toBe('a\n\nb');
  });
});

describe('fetchWeb', () => {
  it('fetches an HTML page and converts it to text', async () => {
    const { fn } = fetchMock(
      () => new Response('<html><body><p>docs here</p></body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    );
    const r = await fetchWeb('https://example.com/', { lookupFn: publicLookup, fetchFn: fn });
    expect(r.status).toBe(200);
    expect(r.contentType).toBe('text/html');
    expect(r.text).toBe('docs here');
  });

  it('returns JSON and plain text bodies untouched', async () => {
    const { fn } = fetchMock(
      () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const r = await fetchWeb('https://api.example.com/x', { lookupFn: publicLookup, fetchFn: fn });
    expect(r.text).toBe('{"ok":true}');
  });

  it('follows redirects, re-validating each hop', async () => {
    const { fn, calls } = fetchMock(
      () => new Response(null, { status: 302, headers: { location: 'https://other.example/page' } }),
      () => new Response('landed', { status: 200, headers: { 'content-type': 'text/plain' } }),
    );
    const r = await fetchWeb('https://example.com/start', { lookupFn: publicLookup, fetchFn: fn });
    expect(r.text).toBe('landed');
    expect(r.url).toBe('https://other.example/page');
    expect(calls).toHaveLength(2);
  });

  it('blocks a redirect that bounces to a private address', async () => {
    const lookup: LookupFn = async (host) => (host === 'evil.example' ? ['93.184.216.34'] : ['127.0.0.1']);
    const { fn } = fetchMock(
      () => new Response(null, { status: 302, headers: { location: 'http://internal.example/admin' } }),
    );
    await expect(fetchWeb('https://evil.example/', { lookupFn: lookup, fetchFn: fn })).rejects.toThrow(
      /private\/loopback/,
    );
  });

  it('gives up after too many redirects', async () => {
    const { fn } = fetchMock(
      () => new Response(null, { status: 301, headers: { location: 'https://example.com/loop' } }),
    );
    await expect(fetchWeb('https://example.com/', { lookupFn: publicLookup, fetchFn: fn })).rejects.toThrow(
      /too many redirects/,
    );
  });

  it('rejects binary content types', async () => {
    const { fn } = fetchMock(
      () => new Response('nope', { status: 200, headers: { 'content-type': 'application/pdf' } }),
    );
    await expect(fetchWeb('https://example.com/f.pdf', { lookupFn: publicLookup, fetchFn: fn })).rejects.toThrow(
      /binary content-type/,
    );
  });

  it('caps the body size and reports the cut', async () => {
    const { fn } = fetchMock(
      () => new Response('x'.repeat(1000), { status: 200, headers: { 'content-type': 'text/plain' } }),
    );
    const r = await fetchWeb('https://example.com/big', {
      lookupFn: publicLookup,
      fetchFn: fn,
      maxBodyBytes: 100,
    });
    expect(r.capped).toBe(true);
  });

  it('detects HTML by sniffing when content-type is missing', async () => {
    // A string body would get an automatic content-type; a stream stays bare.
    const { fn } = fetchMock(() => new Response(byteStream(['<!doctype html><html><body><p>hi</p></body></html>']), { status: 200 }));
    const r = await fetchWeb('https://example.com/', { lookupFn: publicLookup, fetchFn: fn });
    expect(r.text).toBe('hi');
  });
});

describe('webFetchTool', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is a read-only tool named WebFetch', () => {
    expect(webFetchTool.name).toBe('WebFetch');
    expect(webFetchTool.isReadOnly).toBe(true);
    expect(webFetchTool.inputSchema.required).toEqual(['url']);
  });

  it('returns page text with an HTTP status header line', async () => {
    const { fn } = fetchMock(
      () => new Response('plain body', { status: 200, headers: { 'content-type': 'text/plain' } }),
    );
    vi.stubGlobal('fetch', fn);
    // public IP literal → no DNS in the guard
    const r = await webFetchTool.call({ url: 'http://93.184.216.34/' }, { cwd: '/', readFiles: new Map() });
    expect(r.ok).toBe(true);
    expect(r.output).toContain('HTTP 200');
    expect(r.output).toContain('plain body');
  });

  it('surfaces guard failures as tool errors', async () => {
    const r = await webFetchTool.call({ url: 'http://127.0.0.1/' }, { cwd: '/', readFiles: new Map() });
    expect(r.ok).toBe(false);
    expect(r.output).toContain('private/loopback');
  });

  it('appends a next-hop reminder to search-results pages only', async () => {
    const page = () => new Response('results', { status: 200, headers: { 'content-type': 'text/html' } });
    vi.stubGlobal('fetch', fetchMock(page).fn);
    const search = await webFetchTool.call(
      { url: 'https://html.duckduckgo.com/html/?q=seoul+weather' },
      { cwd: '/', readFiles: new Map() },
    );
    expect(search.output).toContain('<system-reminder>');
    expect(search.output).toContain('search RESULTS page');

    vi.stubGlobal('fetch', fetchMock(page).fn);
    const normal = await webFetchTool.call({ url: 'http://93.184.216.34/' }, { cwd: '/', readFiles: new Map() });
    expect(normal.output).not.toContain('<system-reminder>');
  });
});
