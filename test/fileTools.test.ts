import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { editTool } from '../src/tools/edit.js';
import { readTool } from '../src/tools/read.js';
import { writeTool } from '../src/tools/write.js';
import { seed, tmpCtx } from './toolHelpers.js';

describe('Read', () => {
  it('returns cat -n style content and records the read', async () => {
    const { dir, ctx } = tmpCtx();
    seed(dir, { 'a.ts': 'one\ntwo\nthree' });
    const res = await readTool.call({ file_path: 'a.ts' }, ctx);
    expect(res.ok).toBe(true);
    expect(res.output).toBe('     1\tone\n     2\ttwo\n     3\tthree');
    expect(ctx.readFiles.has(path.join(dir, 'a.ts'))).toBe(true);
  });

  it('supports offset/limit and reports truncation with an escape hatch', async () => {
    const { dir, ctx } = tmpCtx();
    seed(dir, { 'a.txt': Array.from({ length: 10 }, (_, i) => `L${i + 1}`).join('\n') });
    const res = await readTool.call({ file_path: 'a.txt', offset: 3, limit: 2 }, ctx);
    expect(res.output).toContain('     3\tL3\n     4\tL4');
    expect(res.output).toContain('showing lines 3-4 of 10');
    expect(res.output).toContain('offset/limit');
  });

  it('fails helpfully on missing files and directories', async () => {
    const { dir, ctx } = tmpCtx();
    expect((await readTool.call({ file_path: 'nope.ts' }, ctx)).ok).toBe(false);
    expect((await readTool.call({ file_path: dir }, ctx)).output).toContain('directory');
  });

  it('flags empty files distinctly', async () => {
    const { dir, ctx } = tmpCtx();
    seed(dir, { 'empty.ts': '' });
    const res = await readTool.call({ file_path: 'empty.ts' }, ctx);
    expect(res.ok).toBe(true);
    expect(res.output).toContain('empty');
  });
});

describe('Write', () => {
  it('creates new files with parent directories, no prior read needed', async () => {
    const { dir, ctx } = tmpCtx();
    const res = await writeTool.call({ file_path: 'deep/dir/new.ts', content: 'x' }, ctx);
    expect(res.ok).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'deep/dir/new.ts'), 'utf8')).toBe('x');
  });

  it('refuses to overwrite an unread existing file', async () => {
    const { dir, ctx } = tmpCtx();
    seed(dir, { 'a.ts': 'original' });
    const res = await writeTool.call({ file_path: 'a.ts', content: 'clobber' }, ctx);
    expect(res.ok).toBe(false);
    expect(res.output).toContain('not read it');
    expect(fs.readFileSync(path.join(dir, 'a.ts'), 'utf8')).toBe('original');
  });

  it('overwrites after a read, and blocks a real external content change', async () => {
    const { dir, ctx } = tmpCtx();
    seed(dir, { 'a.ts': 'original' });
    await readTool.call({ file_path: 'a.ts' }, ctx);
    expect((await writeTool.call({ file_path: 'a.ts', content: 'v2' }, ctx)).ok).toBe(true);

    // an external editor rewrites the file with different content after our write
    const abs = path.join(dir, 'a.ts');
    fs.writeFileSync(abs, 'edited by someone else', 'utf8');
    const mark = ctx.readFiles.get(abs)!;
    ctx.readFiles.set(abs, { ...mark, mtimeMs: mark.mtimeMs - 5 }); // force the mtime fast-path to miss

    const res = await writeTool.call({ file_path: 'a.ts', content: 'v3' }, ctx);
    expect(res.ok).toBe(false);
    expect(res.output).toContain('modified on disk');
    expect(fs.readFileSync(abs, 'utf8')).toBe('edited by someone else'); // not clobbered
  });

  it('allows a write when only the mtime changed (content identical)', async () => {
    const { dir, ctx } = tmpCtx();
    seed(dir, { 'a.ts': 'original' });
    await readTool.call({ file_path: 'a.ts' }, ctx);

    // a formatter/touch/preview-server bumps mtime without changing the bytes
    const abs = path.join(dir, 'a.ts');
    const mark = ctx.readFiles.get(abs)!;
    ctx.readFiles.set(abs, { ...mark, mtimeMs: mark.mtimeMs - 5 });

    const res = await writeTool.call({ file_path: 'a.ts', content: 'v2' }, ctx);
    expect(res.ok).toBe(true);
    expect(fs.readFileSync(abs, 'utf8')).toBe('v2');
  });
});

describe('Edit', () => {
  async function readFirst(dir: string, ctx: any, rel = 'a.ts') {
    await readTool.call({ file_path: rel }, ctx);
  }

  it('requires a prior read', async () => {
    const { dir, ctx } = tmpCtx();
    seed(dir, { 'a.ts': 'const x = 1;' });
    const res = await editTool.call({ file_path: 'a.ts', old_string: '1', new_string: '2' }, ctx);
    expect(res.ok).toBe(false);
    expect(res.output).toContain('must Read');
  });

  it('replaces a unique match and shows surrounding context', async () => {
    const { dir, ctx } = tmpCtx();
    seed(dir, { 'a.ts': 'function add(a, b) {\n  return a - b;\n}\n' });
    await readFirst(dir, ctx);
    const res = await editTool.call(
      { file_path: 'a.ts', old_string: 'return a - b;', new_string: 'return a + b;' },
      ctx,
    );
    expect(res.ok).toBe(true);
    expect(res.output).toContain('return a + b;');
    expect(fs.readFileSync(path.join(dir, 'a.ts'), 'utf8')).toContain('a + b');
  });

  it('rejects non-unique old_string with actionable guidance, honors replace_all', async () => {
    const { dir, ctx } = tmpCtx();
    seed(dir, { 'a.ts': 'foo();\nfoo();\n' });
    await readFirst(dir, ctx);
    const res = await editTool.call({ file_path: 'a.ts', old_string: 'foo()', new_string: 'bar()' }, ctx);
    expect(res.ok).toBe(false);
    expect(res.output).toContain('2 times');
    expect(res.output).toContain('replace_all');

    const all = await editTool.call(
      { file_path: 'a.ts', old_string: 'foo()', new_string: 'bar()', replace_all: true },
      ctx,
    );
    expect(all.ok).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'a.ts'), 'utf8')).toBe('bar();\nbar();\n');
  });

  it('rejects missing old_string and identical strings', async () => {
    const { dir, ctx } = tmpCtx();
    seed(dir, { 'a.ts': 'hello' });
    await readFirst(dir, ctx);
    expect((await editTool.call({ file_path: 'a.ts', old_string: 'x', new_string: 'x' }, ctx)).output).toContain(
      'identical',
    );
    expect(
      (await editTool.call({ file_path: 'a.ts', old_string: 'absent', new_string: 'x' }, ctx)).output,
    ).toContain('not found');
  });

  it('blocks an edit when the content changed on disk since the read', async () => {
    const { dir, ctx } = tmpCtx();
    seed(dir, { 'a.ts': 'hello' });
    await readFirst(dir, ctx);
    const abs = path.join(dir, 'a.ts');
    fs.writeFileSync(abs, 'hello world', 'utf8'); // external change
    const mark = ctx.readFiles.get(abs)!;
    ctx.readFiles.set(abs, { ...mark, mtimeMs: mark.mtimeMs - 5 });
    const res = await editTool.call({ file_path: 'a.ts', old_string: 'hello', new_string: 'bye' }, ctx);
    expect(res.ok).toBe(false);
    expect(res.output).toContain('modified on disk');
  });

  it('allows an edit when only the mtime changed (content identical)', async () => {
    const { dir, ctx } = tmpCtx();
    seed(dir, { 'a.ts': 'hello' });
    await readFirst(dir, ctx);
    const abs = path.join(dir, 'a.ts');
    const mark = ctx.readFiles.get(abs)!;
    ctx.readFiles.set(abs, { ...mark, mtimeMs: mark.mtimeMs - 5 }); // touch, same bytes
    const res = await editTool.call({ file_path: 'a.ts', old_string: 'hello', new_string: 'bye' }, ctx);
    expect(res.ok).toBe(true);
    expect(fs.readFileSync(abs, 'utf8')).toBe('bye');
  });

  it('recovers old_string that includes line-number prefixes from Read', async () => {
    const { dir, ctx } = tmpCtx();
    seed(dir, { 'a.ts': 'function add(a, b) {\n  return a - b;\n}\n' });
    await readFirst(dir, ctx);
    const res = await editTool.call(
      {
        file_path: 'a.ts',
        old_string: '     1\tfunction add(a, b) {\n     2\t  return a - b;\n     3\t}',
        new_string: 'function add(a, b) {\n  return a + b;\n}',
      },
      ctx,
    );
    expect(res.ok).toBe(true);
    expect(res.output).toContain('line-number prefixes');
    expect(fs.readFileSync(path.join(dir, 'a.ts'), 'utf8')).toContain('a + b');
  });

  it('strips line-number prefixes from new_string too when recovery kicks in', async () => {
    const { dir, ctx } = tmpCtx();
    seed(dir, { 'a.ts': 'function add(a, b) {\n  return a - b;\n}\n' });
    await readFirst(dir, ctx);
    const res = await editTool.call(
      {
        file_path: 'a.ts',
        old_string: '     2\t  return a - b;',
        new_string: '     2\t  return a + b;', // model copies prefixes into both
      },
      ctx,
    );
    expect(res.ok).toBe(true);
    expect(res.output).toContain('also removed from new_string');
    const content = fs.readFileSync(path.join(dir, 'a.ts'), 'utf8');
    expect(content).toBe('function add(a, b) {\n  return a + b;\n}\n');
    expect(content).not.toMatch(/\d\t/);
  });

  it('recovers a whitespace-mismatched old_string when the match is unique', async () => {
    const { dir, ctx } = tmpCtx();
    seed(dir, { 'a.ts': 'if (x) {\n\treturn a - b;\n}\n' }); // tab-indented file
    await readFirst(dir, ctx);
    const res = await editTool.call(
      // model guesses two-space indentation — not a substring of the file
      { file_path: 'a.ts', old_string: 'if (x) {\n  return a - b;\n}', new_string: 'if (x) {\n\treturn a + b;\n}' },
      ctx,
    );
    expect(res.ok).toBe(true);
    expect(res.output).toContain('ignoring surrounding whitespace');
    expect(fs.readFileSync(path.join(dir, 'a.ts'), 'utf8')).toBe('if (x) {\n\treturn a + b;\n}\n');
  });

  it('rejects whitespace-relaxed matches that are ambiguous', async () => {
    const { dir, ctx } = tmpCtx();
    seed(dir, { 'a.ts': '  foo();\n\tfoo();\n' });
    await readFirst(dir, ctx);
    const res = await editTool.call({ file_path: 'a.ts', old_string: '    foo();', new_string: 'bar();' }, ctx);
    expect(res.ok).toBe(false);
    expect(res.output).toContain('multiple locations');
  });

  it('allows consecutive edits without re-reading (mtime tracked through edits)', async () => {
    const { dir, ctx } = tmpCtx();
    seed(dir, { 'a.ts': 'one two three' });
    await readFirst(dir, ctx);
    expect((await editTool.call({ file_path: 'a.ts', old_string: 'one', new_string: '1' }, ctx)).ok).toBe(true);
    expect((await editTool.call({ file_path: 'a.ts', old_string: 'two', new_string: '2' }, ctx)).ok).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'a.ts'), 'utf8')).toBe('1 2 three');
  });
});
