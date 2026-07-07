import type { PromptTier } from '../models/profile.js';

/** Minimal JSON-Schema subset our tools need (see schema.ts for validation). */
export interface InputSchema {
  type: 'object';
  properties: Record<
    string,
    {
      type: 'string' | 'number' | 'integer' | 'boolean';
      description?: string;
      enum?: string[];
    }
  >;
  required?: string[];
}

export interface ToolResult {
  ok: boolean;
  /** What the model sees. Error text is wrapped in <tool_error> by the loop. */
  output: string;
  /** One-line summary for the UI (falls back to a generic message). */
  display?: string;
}

export interface ToolContext {
  cwd: string;
  /**
   * Absolute path → mtimeMs at last Read (or last write by us). The code half
   * of the read-before-edit contract: prompts teach it, this enforces it.
   */
  readFiles: Map<string, number>;
}

export type RiskLevel = 'read' | 'mutate' | 'destructive';

export interface Tool {
  name: string;
  isReadOnly: boolean;
  inputSchema: InputSchema;
  description(tier: PromptTier): string;
  /** One-line call summary for UI lines like "→ Read src/foo.ts". */
  summarize(input: Record<string, unknown>, ctx: ToolContext): string;
  /** Filesystem path this call mutates, for permission scoping. */
  pathOf?(input: Record<string, unknown>, ctx: ToolContext): string | undefined;
  /** Per-call risk override (e.g. Bash classifies each command); defaults to isReadOnly. */
  riskOf?(input: Record<string, unknown>, ctx: ToolContext): RiskLevel;
  call(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export function err(message: string): ToolResult {
  return { ok: false, output: message };
}
