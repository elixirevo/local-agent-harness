import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CheckpointStore } from '../src/checkpoints/store.js';

const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ckpt-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

const write = (dir: string, rel: string, content: string) => {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
};

describe('CheckpointStore', () => {
  it('snapshots changes and skips no-op snapshots', async () => {
    const cwd = tmp();
    const store = new CheckpointStore(cwd);
    write(cwd, 'a.txt', 'v1');
    expect(await store.snapshot('first')).toBe(true);
    expect(await store.snapshot('same state')).toBe(false); // nothing changed
    write(cwd, 'a.txt', 'v2');
    expect(await store.snapshot('second')).toBe(true);
    const list = await store.list();
    expect(list.map((c) => c.label)).toEqual(['second', 'first']); // newest first
  });

  it('restores content, removes later files, and is itself rewindable', async () => {
    const cwd = tmp();
    const store = new CheckpointStore(cwd);
    write(cwd, 'a.txt', 'v1');
    await store.snapshot('cp1');
    write(cwd, 'a.txt', 'v2');
    write(cwd, 'b.txt', 'created later');
    await store.snapshot('cp2');
    write(cwd, 'a.txt', 'v3');
    write(cwd, 'c.txt', 'never snapshotted');

    const cp1 = (await store.list()).find((c) => c.label === 'cp1')!;
    await store.restore(cp1.sha);
    expect(fs.readFileSync(path.join(cwd, 'a.txt'), 'utf8')).toBe('v1');
    expect(fs.existsSync(path.join(cwd, 'b.txt'))).toBe(false);
    expect(fs.existsSync(path.join(cwd, 'c.txt'))).toBe(false);

    // The rewind snapshotted the pre-restore state — going back restores v3 AND c.txt.
    const before = (await store.list()).find((c) => c.label === 'before /rewind')!;
    await store.restore(before.sha);
    expect(fs.readFileSync(path.join(cwd, 'a.txt'), 'utf8')).toBe('v3');
    expect(fs.readFileSync(path.join(cwd, 'c.txt'), 'utf8')).toBe('never snapshotted');
  });

  it('never tracks .harness or node_modules, and restore leaves them alone', async () => {
    const cwd = tmp();
    const store = new CheckpointStore(cwd);
    write(cwd, 'src/x.ts', 'code');
    write(cwd, '.harness/sessions/s.jsonl', '{"role":"user"}');
    write(cwd, 'node_modules/pkg/i.js', 'dep');
    await store.snapshot('cp');
    write(cwd, 'src/x.ts', 'code2');
    const cp = (await store.list()).find((c) => c.label === 'cp')!;
    await store.restore(cp.sha);
    expect(fs.readFileSync(path.join(cwd, 'src/x.ts'), 'utf8')).toBe('code');
    // excluded paths survive both snapshot and clean
    expect(fs.existsSync(path.join(cwd, '.harness/sessions/s.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(cwd, 'node_modules/pkg/i.js'))).toBe(true);
  });

  it('coexists with a real git repository in the work tree', async () => {
    const cwd = tmp();
    const { execFileSync } = await import('node:child_process');
    execFileSync('git', ['init', '--quiet'], { cwd });
    write(cwd, 'tracked.ts', 'original');
    const store = new CheckpointStore(cwd);
    await store.snapshot('base');
    write(cwd, 'tracked.ts', 'changed');
    const base = (await store.list()).find((c) => c.label === 'base')!;
    await store.restore(base.sha);
    expect(fs.readFileSync(path.join(cwd, 'tracked.ts'), 'utf8')).toBe('original');
    // the project's own git dir is untouched
    expect(fs.existsSync(path.join(cwd, '.git/HEAD'))).toBe(true);
  });

  it('lists empty before any snapshot', async () => {
    const store = new CheckpointStore(tmp());
    expect(await store.list()).toEqual([]);
  });
});
