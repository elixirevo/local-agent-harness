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

/** What we last saw for a file: the optimistic-lock state for write/edit. */
export interface FileMark {
  /** mtimeMs at our last Read (or last write by us) — the fast-path lock key. */
  mtimeMs: number;
  /**
   * Content hash at that point. When mtime alone changes (a formatter, an
   * editor, `touch`, a preview server rewriting identical bytes) the content
   * check keeps it from being a false "file was modified" conflict.
   */
  hash: string;
}

/** OS sandbox for command execution (macOS Seatbelt), when active. */
export interface SandboxState {
  /** Seatbelt profile computed for this session's cwd. */
  profile: string;
  /** True when unsandboxed bypass is not allowed (approval-free subagents). */
  forced?: boolean;
}

export interface ToolContext {
  cwd: string;
  /**
   * Absolute path → what we last saw. The code half of the read-before-edit
   * contract: prompts teach it, this enforces it.
   */
  readFiles: Map<string, FileMark>;
  /** Present when Bash commands should run inside the OS sandbox. */
  sandbox?: SandboxState;
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
  /** True when this specific call will execute inside the OS sandbox. */
  sandboxedRun?(input: Record<string, unknown>, ctx: ToolContext): boolean;
  call(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export function err(message: string): ToolResult {
  return { ok: false, output: message };
}
