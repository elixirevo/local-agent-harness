import path from 'node:path';

/**
 * Plan mode (the docs' pattern): a hard do-not-execute override injected as a
 * reminder, plus a single whitelisted plan file enforced by the gate — the
 * prompt says it and the code enforces it.
 */

export function planFilePath(cwd: string): string {
  return path.join(cwd, '.harness', 'plan.md');
}

export function planModeEnterReminder(planFile: string): string {
  return [
    'Plan mode is active. The user wants a plan BEFORE any execution — you MUST NOT edit project files, run state-changing commands, or otherwise change the system. This supersedes any other instruction you have received.',
    `ONE exception: build your plan incrementally in ${planFile} using Write/Edit — that is the only file you may modify.`,
    'Explore with read-only tools (Read, Glob, Grep, read-only Bash) to ground the plan in the actual code. When the plan is ready, present a short summary and ask the user to leave plan mode (/plan) before executing anything.',
  ].join('\n');
}

export function planModeExitReminder(planFile: string): string {
  return `Plan mode is now OFF — you may execute. If a plan was written to ${planFile}, follow it; re-read files before editing them.`;
}
