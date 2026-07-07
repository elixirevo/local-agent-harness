import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { rememberNote } from '../src/session/memory.js';
import { tmpCtx } from './toolHelpers.js';

const read = (dir: string) => fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');

describe('rememberNote', () => {
  it('creates AGENTS.md with a managed section and a dated bullet', () => {
    const { dir } = tmpCtx();
    const { file, created } = rememberNote(dir, 'the build uses esbuild, not tsc');
    expect(created).toBe(true);
    expect(file).toBe(path.join(dir, 'AGENTS.md'));
    const content = read(dir);
    expect(content).toContain('## Harness notes');
    expect(content).toMatch(/- \(\d{4}-\d{2}-\d{2}\) the build uses esbuild, not tsc/);
  });

  it('appends further notes under the same section without duplicating it', () => {
    const { dir } = tmpCtx();
    rememberNote(dir, 'first note');
    const res = rememberNote(dir, 'second note');
    expect(res.created).toBe(false);
    const content = read(dir);
    expect(content.match(/## Harness notes/g)).toHaveLength(1);
    expect(content).toContain('first note');
    expect(content).toContain('second note');
    expect(content.indexOf('first note')).toBeLessThan(content.indexOf('second note'));
  });

  it("preserves the user's existing content and appends the section", () => {
    const { dir } = tmpCtx();
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# My project\n\nUse tabs.\n');
    rememberNote(dir, 'remembered thing');
    const content = read(dir);
    expect(content).toContain('# My project');
    expect(content).toContain('Use tabs.');
    expect(content).toContain('## Harness notes');
    expect(content.indexOf('Use tabs.')).toBeLessThan(content.indexOf('## Harness notes'));
  });

  it('inserts into an existing section before a following heading', () => {
    const { dir } = tmpCtx();
    fs.writeFileSync(
      path.join(dir, 'AGENTS.md'),
      '## Harness notes\n- (2026-01-01) old note\n\n## Other section\nkeep me\n',
    );
    rememberNote(dir, 'new note');
    const content = read(dir);
    expect(content).toContain('old note');
    expect(content).toContain('new note');
    expect(content).toContain('## Other section');
    expect(content.indexOf('new note')).toBeLessThan(content.indexOf('## Other section'));
    expect(content.indexOf('keep me')).toBeGreaterThan(content.indexOf('## Other section'));
  });

  it('round-trips into the next session startup context', async () => {
    const { dir } = tmpCtx();
    rememberNote(dir, 'ROUNDTRIP-MARKER');
    const { startupContext } = await import('../src/context/startup.js');
    expect(startupContext(dir)).toContain('ROUNDTRIP-MARKER');
  });
});
