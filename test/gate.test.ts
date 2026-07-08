import { describe, expect, it } from 'vitest';
import { PermissionGate, type Approval } from '../src/permissions/gate.js';
import { bashTool } from '../src/tools/bash.js';
import { writeTool } from '../src/tools/write.js';
import type { Tool, ToolContext } from '../src/tools/types.js';
import { tmpCtx } from './toolHelpers.js';

const answer = (a: Approval) => async () => a;

describe('PermissionGate approvals', () => {
  it('once allows only the current call', async () => {
    const { ctx } = tmpCtx();
    const gate = new PermissionGate('ask', ctx.cwd, answer('once'));
    expect((await gate.check(writeTool, { file_path: 'a', content: 'x' }, ctx)).allowed).toBe(true);
  });

  it('always adds the tool to the session allowlist so it is not asked again', async () => {
    const { ctx } = tmpCtx();
    let calls = 0;
    const allow = new Set<string>();
    const gate = new PermissionGate(
      'ask',
      ctx.cwd,
      async () => {
        calls++;
        return 'always';
      },
      undefined,
      allow,
    );
    await gate.check(writeTool, { file_path: 'a', content: 'x' }, ctx);
    const second = await gate.check(writeTool, { file_path: 'b', content: 'y' }, ctx);
    expect(calls).toBe(1);
    expect(second.allowed).toBe(true);
    expect(second.autoAllowed).toBe(true);
    expect(allow.has('Write')).toBe(true);
  });

  it('shares the allowlist across gate rebuilds (mode/plan toggles)', async () => {
    const { ctx } = tmpCtx();
    const allow = new Set<string>();
    const g1 = new PermissionGate('ask', ctx.cwd, answer('always'), undefined, allow);
    await g1.check(writeTool, { file_path: 'a', content: 'x' }, ctx);
    // a fresh gate built later in the session sees the same allowlist
    const g2 = new PermissionGate('ask', ctx.cwd, answer('deny'), undefined, allow);
    expect((await g2.check(writeTool, { file_path: 'c', content: 'z' }, ctx)).allowed).toBe(true);
  });

  it('never offers or persists "always" for destructive commands', async () => {
    const { ctx } = tmpCtx();
    const allow = new Set<string>();
    let sawAllowAlways: boolean | undefined;
    const gate = new PermissionGate(
      'ask',
      ctx.cwd,
      async (_summary, allowAlways) => {
        sawAllowAlways = allowAlways;
        return 'always'; // even if the answer is "always"...
      },
      undefined,
      allow,
    );
    const decision = await gate.check(bashTool, { command: 'rm -rf build' }, ctx);
    expect(sawAllowAlways).toBe(false); // ...the prompt was told not to offer it
    expect(decision.allowed).toBe(true); // treated as a one-time yes
    expect(allow.has('Bash')).toBe(false); // and NOT remembered
  });

  it('deny blocks the call', async () => {
    const { ctx } = tmpCtx();
    const gate = new PermissionGate('ask', ctx.cwd, answer('deny'));
    const d = await gate.check(writeTool, { file_path: 'a', content: 'x' }, ctx);
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain('denied');
  });

  it('a session-allowed tool is still blocked in plan mode', async () => {
    const { ctx } = tmpCtx();
    const allow = new Set<string>(['Write']);
    const gate = new PermissionGate('plan', ctx.cwd, answer('once'), '/nope/plan.md', allow);
    expect((await gate.check(writeTool, { file_path: 'a.ts', content: 'x' }, ctx)).allowed).toBe(false);
  });
});
