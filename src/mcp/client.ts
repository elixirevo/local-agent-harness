import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

/**
 * Minimal MCP client over the stdio transport: newline-delimited JSON-RPC 2.0.
 * Covers what the harness needs — initialize handshake, tools/list,
 * tools/call — with per-request timeouts. Server stderr is collected for
 * diagnostics but never parsed.
 */

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

export interface McpCallResult {
  text: string;
  isError: boolean;
}

const PROTOCOL_VERSION = '2024-11-05';
const REQUEST_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 120_000;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class McpClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buffer = '';
  private stderrTail = '';
  private closed = false;
  serverInfo?: { name?: string; version?: string };

  constructor(
    readonly name: string,
    private readonly config: McpServerConfig,
  ) {}

  async connect(): Promise<void> {
    this.child = spawn(this.config.command, this.config.args ?? [], {
      env: { ...process.env, ...this.config.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout.on('data', (chunk: Buffer) => this.onData(chunk));
    this.child.stderr.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-2000);
    });
    this.child.on('error', (e) => this.failAll(new Error(`mcp[${this.name}] spawn failed: ${e.message}`)));
    this.child.on('close', () => {
      this.closed = true;
      this.failAll(new Error(`mcp[${this.name}] server exited${this.stderrTail ? ` — stderr: ${this.stderrTail.slice(-300)}` : ''}`));
    });

    const result = (await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'agent-harness', version: '0.1.0' },
    })) as { serverInfo?: { name?: string; version?: string } };
    this.serverInfo = result?.serverInfo;
    this.notify('notifications/initialized', {});
  }

  async listTools(): Promise<McpToolInfo[]> {
    const result = (await this.request('tools/list', {})) as { tools?: McpToolInfo[] };
    return result?.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const result = (await this.request('tools/call', { name, arguments: args }, CALL_TIMEOUT_MS)) as {
      content?: Array<{ type: string; text?: string; [k: string]: unknown }>;
      isError?: boolean;
    };
    const parts = (result?.content ?? []).map((c) =>
      c.type === 'text' && typeof c.text === 'string' ? c.text : `[${c.type} content]`,
    );
    return { text: parts.join('\n') || '(empty result)', isError: result?.isError === true };
  }

  close(): void {
    this.closed = true;
    this.failAll(new Error(`mcp[${this.name}] client closed`));
    this.child?.kill();
    this.child = undefined;
  }

  private request(method: string, params: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    if (!this.child || this.closed) {
      return Promise.reject(new Error(`mcp[${this.name}] not connected`));
    }
    const id = this.nextId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`mcp[${this.name}] ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.send({ jsonrpc: '2.0', id, method, params });
    return promise;
  }

  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  private send(message: unknown): void {
    this.child?.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8');
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        continue; // tolerate stray non-JSON output on stdout
      }
      if (typeof message.id === 'number' && this.pending.has(message.id)) {
        const entry = this.pending.get(message.id)!;
        this.pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error) {
          entry.reject(new Error(`mcp[${this.name}]: ${message.error.message ?? JSON.stringify(message.error)}`));
        } else {
          entry.resolve(message.result);
        }
      }
      // Server-initiated requests/notifications are ignored in v1.
    }
  }

  private failAll(error: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }
}
