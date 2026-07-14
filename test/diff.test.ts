import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { lineOf, renderDiff } from '../src/tools/diff.js';
import { editTool } from '../src/tools/edit.js';
import { writeTool } from '../src/tools/write.js';
import { seed, tmpCtx } from './toolHelpers.js';

describe('renderDiff', () => {
  it('trims common prefix/suffix and shows only the changed region', () => {
    const oldText = 'a\nb\nc\nd';
    const newText = 'a\nB!\nc\nd';
    const d = renderDiff(oldText, newText);
    expect(d).toBe('@@ line 2 @@\n- b\n+ B!');
  });

  it('handles pure insertion and pure deletion', () => {
    expect(renderDiff('a\nc', 'a\nb\nc')).toBe('@@ line 2 @@\n+ b');
    expect(renderDiff('a\nb\nc', 'a\nc')).toBe('@@ line 2 @@\n- b');
  });

  it('caps long diffs per side and reports the remainder', () => {
    const oldText = Array.from({ length: 30 }, (_, i) => `old${i}`).join('\n');
    const newText = Array.from({ length: 30 }, (_, i) => `new${i}`).join('\n');
    const d = renderDiff(oldText, newText, { maxLines: 3 });
    expect(d).toContain('- … (27 more lines)');
    expect(d).toContain('+ … (27 more lines)');
  });

  it('clips very long lines', () => {
    const d = renderDiff('short', 'x'.repeat(500));
    expect(d).toContain('…');
    expect(d.length).toBeLessThan(300);
  });

  it('honors startLine for real file positions', () => {
    expect(renderDiff('b', 'B', { startLine: 42 })).toContain('@@ line 42 @@');
  });

  it('reports no changes for identical inputs', () => {
    expect(renderDiff('same', 'same')).toBe('(no changes)');
  });
});

describe('lineOf', () => {
  it('finds the 1-based line of a fragment', () => {
    expect(lineOf('a\nb\nneedle here\nc', 'needle')).toBe(3);
    expect(lineOf('abc', 'zzz')).toBeUndefined();
  });
});

describe('tool previews', () => {
  it('Edit previews a diff anchored at the real file line', () => {
    const { dir, ctx } = tmpCtx();
    seed(dir, { 'app.ts': 'one\ntwo\nthree\n' });
    const p = editTool.preview!({ file_path: 'app.ts', old_string: 'two', new_string: 'TWO' }, ctx);
    expect(p).toContain('@@ line 2 @@');
    expect(p).toContain('- two');
    expect(p).toContain('+ TWO');
  });

  it('Edit notes replace_all', () => {
    const { dir, ctx } = tmpCtx();
    seed(dir, { 'app.ts': 'x\n' });
    const p = editTool.preview!({ file_path: 'app.ts', old_string: 'x', new_string: 'y', replace_all: true }, ctx);
    expect(p).toContain('(replace all occurrences)');
  });

  it('Write previews a diff for existing files and a head for new files', () => {
    const { dir, ctx } = tmpCtx();
    seed(dir, { 'a.txt': 'old content\n' });
    const changed = writeTool.preview!({ file_path: 'a.txt', content: 'new content\n' }, ctx);
    expect(changed).toContain('- old content');
    expect(changed).toContain('+ new content');

    const fresh = writeTool.preview!({ file_path: 'b.txt', content: 'l1\nl2' }, ctx);
    expect(fresh).toContain('new file · 2 lines');
    expect(fresh).toContain('+ l1');
    expect(fs.existsSync(path.join(dir, 'b.txt'))).toBe(false); // preview writes nothing
  });
});
