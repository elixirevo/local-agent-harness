import type { PromptTier } from '../models/profile.js';
import type { InputSchema, Tool, ToolResult } from '../tools/types.js';
import type { McpClient, McpToolInfo } from './client.js';

const DESCRIPTION_LIMIT = 600;

/**
 * Wrap an MCP tool as a harness tool, namespaced mcp__{server}__{tool} (the
 * established convention, and it prevents collisions with built-ins). The
 * server's own JSON Schema is passed to the model verbatim; local validation
 * only checks the parts it understands and the server remains the authority.
 * Risk: readOnlyHint annotations are trusted for read-only treatment;
 * everything else counts as a mutation and goes through the gate like any
 * other mutating tool.
 */
export function wrapMcpTool(client: McpClient, info: McpToolInfo): Tool {
  const name = `mcp__${sanitize(client.name)}__${sanitize(info.name)}`;
  const readOnly = info.annotations?.readOnlyHint === true;
  const schema = (info.inputSchema ?? { type: 'object', properties: {} }) as unknown as InputSchema;

  return {
    name,
    isReadOnly: readOnly,
    inputSchema: schema,
    description(_tier: PromptTier): string {
      const desc = (info.description ?? '(no description provided by the server)').trim();
      const body = desc.length > DESCRIPTION_LIMIT ? `${desc.slice(0, DESCRIPTION_LIMIT)}…` : desc;
      return `[MCP tool from server "${client.name}"] ${body}`;
    },
    summarize(input) {
      const keys = Object.keys(input);
      const first = keys.length > 0 ? `${keys[0]}: ${JSON.stringify(input[keys[0]]).slice(0, 40)}` : '';
      return `${info.name}(${first}${keys.length > 1 ? ', …' : ''})`;
    },
    riskOf() {
      return readOnly ? 'read' : 'mutate';
    },
    async call(input): Promise<ToolResult> {
      const result = await client.callTool(info.name, input);
      if (result.isError) {
        return { ok: false, output: result.text };
      }
      return { ok: true, output: result.text, display: `${result.text.length} chars` };
    },
  };
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_');
}
