import { describe, expect, it } from 'vitest';
import { globTool } from '../src/tools/glob.js';
import { grepTool } from '../src/tools/grep.js';
import { globToRegExp, matchGlob } from '../src/tools/walk.js';
import { seed, tmpCtx } from './toolHelpers.js';

describe('globToRegExp', () => {
  const cases: Array<[string, string, boolean]> = [
    ['**/*.ts', 'src/deep/a.ts', true],
    ['**/*.ts', 'a.ts', true],
    ['**/*.ts', 'a.tsx', false],
    ['src/**/*.{ts,tsx}', 'src/x/y.tsx', true],
    ['src/**/*.{ts,tsx}', 'lib/y.ts', false],
    ['*.ts', 'deep/nested/a.ts', true], // basename semantics without "/"
    ['a?c.md', 'abc.md', true],
    ['a?c.md', 'ab/c.md', false],
  ];
  it.each(cases)('%s vs %s → %s', (pattern, rel, expected) => {
    expect(matchGlob(globToRegExp(pattern), rel)).toBe(expected);
  });
});

describe('Glob tool', () => {
  it('finds files newest-first and skips junk directories', async () => {
    const { dir, ctx } = tmpCtx();
    seed(dir, {
      'src/a.ts': 'a',
      'src/deep/b.ts': 'b',
      'node_modules/x/c.ts': 'junk',
      'README.md': 'doc',
    });
    const res = await globTool.call({ pattern: '**/*.ts' }, ctx);
    expect(res.ok).toBe(true);
    const lines = res.output.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines).toContain('src/a.ts');
    expect(lines).toContain('src/deep/b.ts');
    expect(res.output).not.toContain('node_modules');
  });

  it('reports zero matches without failing', async () => {
    const { ctx } = tmpCtx();
    const res = await globTool.call({ pattern: '*.rs' }, ctx);
    expect(res.ok).toBe(true);
    expect(res.output).toContain('No files match');
  });
});

describe('Grep tool', () => {
  it('lists files, shows content lines, and counts', async () => {
    const { dir, ctx } = tmpCtx();
    seed(dir, {
      'src/a.ts': 'const total = add(1, 2);\nexport { add };',
      'src/b.ts': 'function add(a, b) { return a + b; }',
      'notes.txt': 'nothing here',
    });
    const files = await grepTool.call({ pattern: 'add\\(' }, ctx);
    expect(files.output.split('\n').sort()).toEqual(['src/a.ts', 'src/b.ts']);

    const content = await grepTool.call({ pattern: 'add\\(', mode: 'content' }, ctx);
    expect(content.output).toContain('src/a.ts:1:const total = add(1, 2);');
    expect(content.output).toContain('src/b.ts:1:function add(a, b) { return a + b; }');

    const count = await grepTool.call({ pattern: 'add', mode: 'count' }, ctx);
    expect(count.output).toContain('src/a.ts: 2');
  });

  it('applies glob filters and case-insensitive flag', async () => {
    const { dir, ctx } = tmpCtx();
    seed(dir, { 'a.ts': 'Hello', 'b.md': 'hello' });
    const res = await grepTool.call({ pattern: 'hello', glob: '*.ts', case_insensitive: true }, ctx);
    expect(res.output.trim()).toBe('a.ts');
    const strict = await grepTool.call({ pattern: 'hello', glob: '*.ts' }, ctx);
    expect(strict.output).toContain('No matches');
  });

  it('rejects invalid regex with guidance', async () => {
    const { ctx } = tmpCtx();
    const res = await grepTool.call({ pattern: '(' }, ctx);
    expect(res.ok).toBe(false);
    expect(res.output).toContain('Invalid regular expression');
  });
});
