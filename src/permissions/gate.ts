import path from 'node:path';
import type { Tool, ToolContext } from '../tools/types.js';

/** 'plan' is entered via --plan//plan, not the --permission-mode flag. */
export type PermissionMode = 'readonly' | 'ask' | 'auto' | 'plan';

export const PERMISSION_MODES: PermissionMode[] = ['readonly', 'ask', 'auto'];

/** The user's answer to an approval prompt. */
export type Approval = 'once' | 'always' | 'deny';

/**
 * Asks the user to approve a call; summary is e.g. "Write(src/app.ts)".
 * allowAlways is false for destructive calls, so "always" is never offered
 * for them.
 */
export type AskFn = (summary: string, allowAlways: boolean) => Promise<Approval>;

export interface GateDecision {
  allowed: boolean;
  /** Model-facing reason on denial. */
  reason?: string;
  /** UI hint: this call was auto-allowed by a prior "always" for its tool. */
  autoAllowed?: boolean;
}

export class PermissionGate {
  constructor(
    readonly mode: PermissionMode,
    private readonly cwd: string,
    private readonly askFn?: AskFn,
    /** In plan mode, the single file mutations are allowed to touch. */
    private readonly planFile?: string,
    /**
     * Tool names the user approved with "always" this session. Shared across
     * gate rebuilds (mode/plan toggles) by passing the same Set in.
     * Destructive calls are never satisfied by it.
     */
    private readonly sessionAllow: Set<string> = new Set(),
  ) {}

  async check(tool: Tool, input: Record<string, unknown>, ctx: ToolContext): Promise<GateDecision> {
    const risk = tool.riskOf?.(input, ctx) ?? (tool.isReadOnly ? 'read' : 'mutate');
    if (risk === 'read') return { allowed: true };
    if (this.mode === 'plan') {
      const target = tool.pathOf?.(input, ctx);
      if (this.planFile && target !== undefined && path.resolve(target) === path.resolve(this.planFile)) {
        return { allowed: true };
      }
      return {
        allowed: false,
        reason: `plan mode is active — no execution or file changes yet. The ONLY file you may write is the plan file${this.planFile ? ` at ${this.planFile}` : ''}`,
      };
    }
    if (this.mode === 'readonly') {
      // Mutating tools are already excluded from the request in readonly mode;
      // this is the code half of the double defense.
      return { allowed: false, reason: 'the session is in read-only mode' };
    }
    // Session allowlist from a prior "always" — never for destructive calls.
    if (risk !== 'destructive' && this.sessionAllow.has(tool.name)) {
      return { allowed: true, autoAllowed: true };
    }
    // A mutate call that will execute inside the OS sandbox is already
    // bounded (writes → cwd+tmp, no network), so ask mode lets it run
    // without a prompt. Destructive never gets this shortcut, and a call
    // escaping the sandbox (unsandboxed: true) reports sandboxedRun=false.
    if (this.mode === 'ask' && risk === 'mutate' && tool.sandboxedRun?.(input, ctx) === true) {
      return { allowed: true, autoAllowed: true };
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
    const approval = await this.askFn(summary, risk !== 'destructive');
    if (approval === 'always' && risk !== 'destructive') {
      this.sessionAllow.add(tool.name);
      return { allowed: true };
    }
    // A stray "always" on a destructive call is treated as a one-time yes.
    if (approval === 'always' || approval === 'once') return { allowed: true };
    return { allowed: false, reason: 'the user denied this call' };
  }
}

function isOutside(cwd: string, target: string): boolean {
  const rel = path.relative(cwd, target);
  return rel.startsWith('..') || path.isAbsolute(rel);
}
