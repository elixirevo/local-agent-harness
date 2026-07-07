import { describe, expect, it } from 'vitest';
import { bashTool } from '../src/tools/bash.js';
import { tmpCtx } from './toolHelpers.js';

describe('Bash tool', () => {
  it('runs a command in the working directory and reports exit code', async () => {
    const { dir, ctx } = tmpCtx();
    const res = await bashTool.call({ command: 'pwd && echo done' }, ctx);
    expect(res.ok).toBe(true);
    expect(res.output).toContain(dir.replace('/private', '')); // macOS tmpdir may resolve /private prefix
    expect(res.output).toContain('done');
    expect(res.output).toContain('(exit code 0)');
  });

  it('captures stderr separately and keeps non-zero exits as information', async () => {
    const { ctx } = tmpCtx();
    const res = await bashTool.call({ command: 'echo out; echo err >&2; exit 3' }, ctx);
    expect(res.ok).toBe(true); // failure of the command ≠ failure of the tool
    expect(res.output).toContain('out');
    expect(res.output).toContain('--- stderr ---');
    expect(res.output).toContain('err');
    expect(res.output).toContain('(exit code 3)');
  });

  it('kills on timeout and reports it as an error', async () => {
    const { ctx } = tmpCtx();
    const res = await bashTool.call({ command: 'sleep 5', timeout: 200 }, ctx);
    expect(res.ok).toBe(false);
    expect(res.output).toContain('timed out after 200ms');
  });

  it('truncates long output keeping head and tail', async () => {
    const { ctx } = tmpCtx();
    const res = await bashTool.call(
      { command: 'i=0; while [ $i -lt 4000 ]; do echo "line $i padding padding"; i=$((i+1)); done' },
      ctx,
    );
    expect(res.ok).toBe(true);
    expect(res.output).toContain('line 0 ');
    expect(res.output).toContain('characters omitted');
    expect(res.output).toContain('line 3999');
  });

  it('reports no output distinctly', async () => {
    const { ctx } = tmpCtx();
    const res = await bashTool.call({ command: 'true' }, ctx);
    expect(res.output).toContain('(no output)');
  });
});
