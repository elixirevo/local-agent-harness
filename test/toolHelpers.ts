import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach } from 'vitest';
import type { ToolContext } from '../src/tools/types.js';

const created: string[] = [];

/** Fresh temp project dir + ToolContext; removed automatically after each test. */
export function tmpCtx(): { dir: string; ctx: ToolContext } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-test-'));
  created.push(dir);
  return { dir, ctx: { cwd: dir, readFiles: new Map() } };
}

afterEach(() => {
  while (created.length > 0) {
    const dir = created.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

export function seed(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
}
