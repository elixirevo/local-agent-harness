import type { PromptTier } from '../models/profile.js';
import type { ToolDef } from '../providers/types.js';
import type { PermissionMode } from '../permissions/gate.js';
import { editTool } from './edit.js';
import { globTool } from './glob.js';
import { grepTool } from './grep.js';
import { readTool } from './read.js';
import type { Tool } from './types.js';
import { writeTool } from './write.js';

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): this {
    this.tools.set(tool.name, tool);
    return this;
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  /**
   * Tools visible to the model under a permission mode. In readonly mode
   * mutating tools are excluded from the request itself (blocked by absence,
   * not by prompt) — the gate stays as the second line of defense.
   */
  list(mode: PermissionMode): Tool[] {
    const all = [...this.tools.values()];
    return mode === 'readonly' ? all.filter((t) => t.isReadOnly) : all;
  }

  toolDefs(mode: PermissionMode, tier: PromptTier): ToolDef[] {
    return this.list(mode).map((t) => ({
      name: t.name,
      description: t.description(tier),
      parameters: t.inputSchema as unknown as Record<string, unknown>,
    }));
  }
}

export function defaultRegistry(): ToolRegistry {
  return new ToolRegistry()
    .register(readTool)
    .register(writeTool)
    .register(editTool)
    .register(globTool)
    .register(grepTool);
}
