import { describe, expect, it } from 'vitest';
import { createAgentTool } from '../src/agents/agentTool.js';
import { PermissionGate } from '../src/permissions/gate.js';
import { planFilePath } from '../src/prompts/planMode.js';
import { bashTool } from '../src/tools/bash.js';
import { editTool } from '../src/tools/edit.js';
import { writeTool } from '../src/tools/write.js';
import { seed, tmpCtx } from './toolHelpers.js';

describe('plan mode gate', () => {
  it('denies mutations except the plan file, allows read-classified Bash', async () => {
    const { dir, ctx } = tmpCtx();
    seed(dir, { 'src/a.ts': 'x' });
    const planFile = planFilePath(dir);
    const gate = new PermissionGate('plan', dir, undefined, planFile);

    const denied = await gate.check(writeTool, { file_path: 'src/a.ts', content: 'y' }, ctx);
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toContain('plan mode');
    expect(denied.reason).toContain(planFile);

    const planWrite = await gate.check(writeTool, { file_path: planFile, content: '# plan' }, ctx);
    expect(planWrite.allowed).toBe(true);
    const planEdit = await gate.check(editTool, { file_path: '.harness/plan.md', old_string: 'a', new_string: 'b' }, ctx);
    expect(planEdit.allowed).toBe(true); // relative path resolves to the same file

    expect((await gate.check(bashTool, { command: 'git status' }, ctx)).allowed).toBe(true);
    expect((await gate.check(bashTool, { command: 'npm test' }, ctx)).allowed).toBe(false);
  });

  it('treats explore delegation as read, verify as mutation', () => {
    const { ctx } = tmpCtx();
    const tool = createAgentTool(() => {
      throw new Error('not used');
    });
    expect(tool.riskOf?.({ agent_type: 'explore', prompt: 'x' }, ctx)).toBe('read');
    expect(tool.riskOf?.({ agent_type: 'verify', prompt: 'x' }, ctx)).toBe('mutate');
  });
});

