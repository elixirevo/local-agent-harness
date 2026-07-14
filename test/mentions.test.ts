import { describe, expect, it } from 'vitest';
import { mentionedPaths } from '../src/cli/repl.js';
import { readTool, resolvePath } from '../src/tools/read.js';
import { seed, tmpCtx } from './toolHelpers.js';

describe('mentionedPaths', () => {
  it('collects @tokens that name existing paths', () => {
    const { dir } = tmpCtx();
    seed(dir, { 'dir/test.txt': 'x', 'a.md': 'y' });
    expect(mentionedPaths('read @dir/test.txt and @a.md', dir)).toEqual(['dir/test.txt', 'a.md']);
    expect(mentionedPaths('@dir/test.txt', dir)).toEqual(['dir/test.txt']);
  });

  it('ignores emails, plain words, and non-existent paths', () => {
    const { dir } = tmpCtx();
    seed(dir, { 'real.txt': 'x' });
    expect(mentionedPaths('mail me at user@host.com', dir)).toEqual([]);
    expect(mentionedPaths('@ghost.txt please', dir)).toEqual([]);
    expect(mentionedPaths('no mentions here', dir)).toEqual([]);
  });

  it('tolerates trailing punctuation and dedupes', () => {
    const { dir } = tmpCtx();
    seed(dir, { 'a.md': 'y' });
    expect(mentionedPaths('what about @a.md? and @a.md again', dir)).toEqual(['a.md']);
  });
});

describe('resolvePath @-recovery', () => {
  it('strips the mention marker when the literal path does not exist', async () => {
    const { dir, ctx } = tmpCtx();
    seed(dir, { 'dir/test.txt': 'found me' });
    const r = await readTool.call({ file_path: '@dir/test.txt' }, ctx);
    expect(r.ok).toBe(true);
    expect(r.output).toContain('found me');
    void dir;
  });

  it('prefers a file genuinely named with a leading @', () => {
    const { dir, ctx } = tmpCtx();
    seed(dir, { '@config.yml': 'at-file', 'config.yml': 'plain' });
    expect(resolvePath('@config.yml', ctx)).toContain('/@config.yml');
    void dir;
  });

  it('leaves non-existent paths untouched for a normal error', async () => {
    const { ctx } = tmpCtx();
    const r = await readTool.call({ file_path: '@nope.txt' }, ctx);
    expect(r.ok).toBe(false);
  });
});
