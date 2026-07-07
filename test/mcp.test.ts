import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { McpClient } from '../src/mcp/client.js';
import { connectMcpServers } from '../src/mcp/index.js';
import { wrapMcpTool } from '../src/mcp/tools.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { validateInput } from '../src/tools/schema.js';
import { tmpCtx } from './toolHelpers.js';

const FIXTURE = path.join(__dirname, 'fixtures', 'mcp-server.cjs');
const serverConfig = { command: process.execPath, args: [FIXTURE] };

const clients: McpClient[] = [];
function makeClient(name = 'fixture'): McpClient {
  const client = new McpClient(name, serverConfig);
  clients.push(client);
  return client;
}

afterEach(() => {
  while (clients.length > 0) clients.pop()!.close();
});

describe('McpClient', () => {
  it('handshakes, lists tools, and calls one', async () => {
    const client = makeClient();
    await client.connect();
    expect(client.serverInfo?.name).toBe('fixture-server');

    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['echo', 'write_note', 'boom', 'slow']);
    expect(tools[0].annotations?.readOnlyHint).toBe(true);

    const result = await client.callTool('echo', { text: 'hello' });
    expect(result).toEqual({ text: 'HELLO', isError: false });
  });

  it('surfaces isError results and JSON-RPC errors distinctly', async () => {
    const client = makeClient();
    await client.connect();
    const boom = await client.callTool('boom', {});
    expect(boom.isError).toBe(true);
    expect(boom.text).toContain('exploded');
    await expect(client.callTool('nope', {})).rejects.toThrow(/unknown tool/);
  });

  it('rejects cleanly when the server never answers or dies', async () => {
    const client = makeClient();
    await client.connect();
    const pending = client.callTool('slow', {});
    client.close(); // simulates a dying server mid-call
    await expect(pending).rejects.toThrow(/closed|exited/);
  });
});

describe('wrapMcpTool + registry integration', () => {
  it('namespaces tools, honors readOnlyHint, and executes through the wrapper', async () => {
    const { ctx } = tmpCtx();
    const registry = new ToolRegistry();
    const [conn] = await connectMcpServers({ fixture: serverConfig }, registry);
    clients.push(conn.client);

    expect(conn.error).toBeUndefined();
    expect(conn.toolNames).toContain('mcp__fixture__echo');
    const echo = registry.get('mcp__fixture__echo')!;
    expect(echo.isReadOnly).toBe(true);
    expect(echo.riskOf?.({}, ctx)).toBe('read');
    expect(echo.description('standard')).toContain('MCP tool from server "fixture"');

    const write = registry.get('mcp__fixture__write_note')!;
    expect(write.isReadOnly).toBe(false);
    // readonly mode exposes only readOnlyHint-ed MCP tools
    const readonlyNames = registry.list('readonly').map((t) => t.name);
    expect(readonlyNames).toContain('mcp__fixture__echo');
    expect(readonlyNames).not.toContain('mcp__fixture__write_note');

    const result = await echo.call({ text: 'harness' }, ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toBe('HARNESS');

    const failed = await registry.get('mcp__fixture__boom')!.call({}, ctx);
    expect(failed.ok).toBe(false);
  });

  it('reports connection failures per server without throwing', async () => {
    const registry = new ToolRegistry();
    const conns = await connectMcpServers(
      { broken: { command: '/nonexistent-mcp-binary' }, fixture: serverConfig },
      registry,
    );
    for (const c of conns) clients.push(c.client);
    const broken = conns.find((c) => c.client.name === 'broken')!;
    expect(broken.error).toBeTruthy();
    const fixture = conns.find((c) => c.client.name === 'fixture')!;
    expect(fixture.error).toBeUndefined();
    expect(registry.get('mcp__fixture__echo')).toBeDefined();
  });
});

describe('validateInput with foreign schemas', () => {
  it('skips property types outside the local subset (server validates those)', () => {
    const schema = {
      type: 'object' as const,
      properties: {
        text: { type: 'string' as const },
        extras: { type: 'object' } as never,
      },
      required: ['text'],
    };
    expect(validateInput(schema, { text: 'hi', extras: { nested: true } })).toEqual([]);
    expect(validateInput(schema, { extras: {} })).toContain('missing required parameter "text"');
  });
});
