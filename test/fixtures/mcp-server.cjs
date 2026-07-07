#!/usr/bin/env node
// Minimal MCP server over stdio (newline-delimited JSON-RPC) for tests.
// Tools: echo (readOnlyHint), slow (never answers within test timeouts),
// boom (isError result).
let buffer = '';

process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let idx;
  while ((idx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (line) handle(JSON.parse(line));
  }
});

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function handle(message) {
  const { id, method, params } = message;
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'fixture-server', version: '1.0.0' },
      },
    });
  } else if (method === 'notifications/initialized') {
    // notification — no response
  } else if (method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        tools: [
          {
            name: 'echo',
            description: 'Echoes the text back, uppercased.',
            inputSchema: {
              type: 'object',
              properties: { text: { type: 'string' }, extras: { type: 'object' } },
              required: ['text'],
            },
            annotations: { readOnlyHint: true },
          },
          {
            name: 'write_note',
            description: 'Pretends to write a note somewhere.',
            inputSchema: { type: 'object', properties: { note: { type: 'string' } }, required: ['note'] },
          },
          {
            name: 'boom',
            description: 'Always fails.',
            inputSchema: { type: 'object', properties: {} },
          },
          {
            name: 'slow',
            description: 'Never answers in time.',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      },
    });
  } else if (method === 'tools/call') {
    const { name, arguments: args } = params;
    if (name === 'echo') {
      send({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: String(args.text).toUpperCase() }] },
      });
    } else if (name === 'write_note') {
      send({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: 'note saved: ' + args.note }] },
      });
    } else if (name === 'boom') {
      send({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: 'the thing exploded' }], isError: true },
      });
    } else if (name === 'slow') {
      // deliberately never respond
    } else {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'unknown tool: ' + name } });
    }
  } else if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'unknown method: ' + method } });
  }
}
