#!/usr/bin/env node
// Minimal MCP server over stdio (newline-delimited JSON-RPC) for tests.
// Tools: echo (readOnlyHint), slow (never answers within test timeouts),
// boom (isError result).
let buffer = '';
let pendingPingCall = null; // tools/call id waiting for the client's pong

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
  // Client's response to our server-initiated ping.
  if (method === undefined && id === 'server-ping-1') {
    if (pendingPingCall !== null) {
      send({ jsonrpc: '2.0', id: pendingPingCall, result: { content: [{ type: 'text', text: 'pong received' }] } });
      pendingPingCall = null;
    }
    return;
  }
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
          {
            name: 'check_ping',
            description: 'Sends the client a ping and reports whether it answered.',
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
    } else if (name === 'check_ping') {
      // Ping the client; the tools/call result is sent once it pongs.
      pendingPingCall = id;
      send({ jsonrpc: '2.0', id: 'server-ping-1', method: 'ping' });
    } else {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'unknown tool: ' + name } });
    }
  } else if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'unknown method: ' + method } });
  }
}
