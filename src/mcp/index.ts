import type { ToolRegistry } from '../tools/registry.js';
import { McpClient, type McpServerConfig } from './client.js';
import { wrapMcpTool } from './tools.js';

export interface McpConnection {
  client: McpClient;
  toolNames: string[];
  error?: string;
}

/**
 * Connect every configured server and register its tools. Failures are
 * isolated per server — a broken config entry degrades to a warning instead
 * of taking the session down.
 */
export async function connectMcpServers(
  servers: Record<string, McpServerConfig>,
  registry: ToolRegistry,
): Promise<McpConnection[]> {
  const entries = Object.entries(servers);
  return Promise.all(
    entries.map(async ([name, config]): Promise<McpConnection> => {
      const client = new McpClient(name, config);
      try {
        await client.connect();
        const tools = await client.listTools();
        const toolNames: string[] = [];
        for (const info of tools) {
          const tool = wrapMcpTool(client, info);
          registry.register(tool);
          toolNames.push(tool.name);
        }
        return { client, toolNames };
      } catch (e) {
        client.close();
        return { client, toolNames: [], error: (e as Error).message };
      }
    }),
  );
}

export function closeMcpConnections(connections: McpConnection[]): void {
  for (const c of connections) c.client.close();
}

export { McpClient, type McpServerConfig };
