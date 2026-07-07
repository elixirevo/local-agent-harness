import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ReminderQueue, systemReminder } from '../src/context/reminders.js';
import { startupContext } from '../src/context/startup.js';
import { seed, tmpCtx } from './toolHelpers.js';

describe('ReminderQueue', () => {
  it('drains queued reminders once, wrapped in system-reminder tags', () => {
    const q = new ReminderQueue('2026-07-07');
    q.enqueue('note one');
    q.enqueue('note two');
    const prefix = q.drainPrefix();
    expect(prefix).toContain(systemReminder('note one'));
    expect(prefix).toContain(systemReminder('note two'));
    expect(q.drainPrefix()).toBe('');
  });

  it('enqueues a date-change note when the day rolls over', () => {
    const q = new ReminderQueue('2026-07-07');
    q.tick('2026-07-07');
    expect(q.drainPrefix()).toBe('');
    q.tick('2026-07-08');
    const prefix = q.drainPrefix();
    expect(prefix).toContain('date has changed');
    expect(prefix).toContain('2026-07-08');
  });
});

describe('startupContext', () => {
  it('includes date, project memory, and the relevance framing', () => {
    const { dir } = tmpCtx();
    seed(dir, { 'AGENTS.md': '# Project notes\nUse tabs.' });
    const ctxText = startupContext(dir);
    expect(ctxText).toContain('# date');
    expect(ctxText).toContain('projectMemory (AGENTS.md)');
    expect(ctxText).toContain('Use tabs.');
    expect(ctxText).toContain('may or may not be relevant');
    expect(ctxText).not.toContain('# gitStatus'); // tmp dir is not a git repo
  });

  it('works without any memory file', () => {
    const { dir } = tmpCtx();
    const ctxText = startupContext(dir);
    expect(ctxText).toContain('# date');
    expect(ctxText).not.toContain('projectMemory');
  });
});

describe('project memory aging', () => {
  it('prefixes old AGENTS.md content with an age note', async () => {
    const { dir } = tmpCtx();
    seed(dir, { 'AGENTS.md': 'Use tabs everywhere.' });
    const file = path.join(dir, 'AGENTS.md');
    const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000);
    fs.utimesSync(file, threeDaysAgo, threeDaysAgo);

    const { startupContext } = await import('../src/context/startup.js');
    const ctxText = startupContext(dir);
    expect(ctxText).toContain('3 days old');
    expect(ctxText).toContain('point-in-time notes');
    expect(ctxText).toContain('Use tabs everywhere.');
  });
});
