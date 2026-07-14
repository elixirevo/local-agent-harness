import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { clearAllowlist, loadAllowlist, settingsPath } from '../src/permissions/allowlist.js';

const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'allow-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('persistent allowlist', () => {
  it('starts empty and persists adds across loads', () => {
    const cwd = tmp();
    const first = loadAllowlist(cwd);
    expect(first.size).toBe(0);
    first.add('Write');
    first.add('Edit');
    const second = loadAllowlist(cwd); // "restart"
    expect([...second].sort()).toEqual(['Edit', 'Write']);
  });

  it('writes valid JSON to .harness/settings.json', () => {
    const cwd = tmp();
    loadAllowlist(cwd).add('Bash');
    const parsed = JSON.parse(fs.readFileSync(settingsPath(cwd), 'utf8'));
    expect(parsed.allowAlways).toEqual(['Bash']);
  });

  it('preserves unrelated settings keys', () => {
    const cwd = tmp();
    fs.mkdirSync(path.join(cwd, '.harness'), { recursive: true });
    fs.writeFileSync(settingsPath(cwd), JSON.stringify({ future: { theme: 'dark' } }));
    loadAllowlist(cwd).add('Write');
    const parsed = JSON.parse(fs.readFileSync(settingsPath(cwd), 'utf8'));
    expect(parsed.future).toEqual({ theme: 'dark' });
    expect(parsed.allowAlways).toEqual(['Write']);
  });

  it('clear empties memory and disk', () => {
    const cwd = tmp();
    const set = loadAllowlist(cwd);
    set.add('Write');
    clearAllowlist(cwd, set);
    expect(set.size).toBe(0);
    expect(loadAllowlist(cwd).size).toBe(0);
  });

  it('tolerates corrupt or non-object settings files', () => {
    const cwd = tmp();
    fs.mkdirSync(path.join(cwd, '.harness'), { recursive: true });
    fs.writeFileSync(settingsPath(cwd), '{not json');
    expect(loadAllowlist(cwd).size).toBe(0);
    fs.writeFileSync(settingsPath(cwd), JSON.stringify({ allowAlways: 'Write' })); // wrong type
    expect(loadAllowlist(cwd).size).toBe(0);
    fs.writeFileSync(settingsPath(cwd), JSON.stringify({ allowAlways: ['Write', 7] })); // mixed
    expect([...loadAllowlist(cwd)]).toEqual(['Write']);
  });
});
