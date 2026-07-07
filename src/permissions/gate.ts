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
    const risk = tool.riskOf?.(input, ctx) ?? (tool.isReadOnly ? 'read' : 'mutate');
    if (risk === 'read') return { allowed: true };
    if (this.mode === 'readonly') {
      // Mutating tools are already excluded from the request in readonly mode;
      // this is the code half of the double defense.
      return { allowed: false, reason: 'the session is in read-only mode' };
    }
    if (this.mode === 'auto' && risk === 'mutate') {
      const target = tool.pathOf?.(input, ctx);
      const outsideCwd = target !== undefined && isOutside(this.cwd, target);
      // Blast-radius guard: auto-approve only inside the working directory.
      // Destructive commands never auto-approve, no matter the mode.
      if (!outsideCwd) return { allowed: true };
    }
    if (!this.askFn) {
      return {
        allowed: false,
        reason:
          `this ${risk === 'destructive' ? 'destructive ' : ''}call needs user approval and no interactive approval is available in this session. The user must approve interactively${risk === 'destructive' ? '' : ' or re-run with --permission-mode=auto'}.`,
      };
    }
    const summary = `${tool.name}(${tool.summarize(input, ctx)})${risk === 'destructive' ? ' [destructive]' : ''}`;
    const approved = await this.askFn(summary);
    return approved ? { allowed: true } : { allowed: false, reason: 'the user denied this call' };
  }
}

function isOutside(cwd: string, target: string): boolean {
  const rel = path.relative(cwd, target);
  return rel.startsWith('..') || path.isAbsolute(rel);
}
