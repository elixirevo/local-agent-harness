import path from 'node:path';
import type { Tool, ToolContext } from '../tools/types.js';

export type PermissionMode = 'readonly' | 'ask' | 'auto';

export const PERMISSION_MODES: PermissionMode[] = ['readonly', 'ask', 'auto'];

/** Asks the user to approve a call; summary is e.g. "Write(src/app.ts)". */
export type AskFn = (summary: string) => Promise<boolean>;

export interface GateDecision {
  allowed: boolean;
  /** Model-facing reason on denial. */
  reason?: string;
}

export class PermissionGate {
  constructor(
    readonly mode: PermissionMode,
    private readonly cwd: string,
    private readonly askFn?: AskFn,
  ) {}

  async check(tool: Tool, input: Record<string, unknown>, ctx: ToolContext): Promise<GateDecision> {
    if (tool.isReadOnly) return { allowed: true };
    if (this.mode === 'readonly') {
      // Mutating tools are already excluded from the request in readonly mode;
      // this is the code half of the double defense.
      return { allowed: false, reason: 'the session is in read-only mode' };
    }
    const target = tool.pathOf?.(input, ctx);
    if (this.mode === 'auto') {
      const outsideCwd = target !== undefined && isOutside(this.cwd, target);
      // Blast-radius guard: auto-approve only inside the working directory.
      if (!outsideCwd) return { allowed: true };
    }
    if (!this.askFn) {
      return {
        allowed: false,
        reason:
          'no interactive approval is available in this session (non-interactive run in "ask" mode). The user must re-run with --permission-mode=auto or approve interactively.',
      };
    }
    const summary = `${tool.name}(${tool.summarize(input, ctx)})`;
    const approved = await this.askFn(summary);
    return approved ? { allowed: true } : { allowed: false, reason: 'the user denied this call' };
  }
}

function isOutside(cwd: string, target: string): boolean {
  const rel = path.relative(cwd, target);
  return rel.startsWith('..') || path.isAbsolute(rel);
}
