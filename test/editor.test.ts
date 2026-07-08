import { describe, expect, it } from 'vitest';
import { filterCommands, InputLine, type SlashCommand } from '../src/cli/editor.js';

describe('InputLine', () => {
  it('inserts, moves the cursor, and backspaces', () => {
    const l = new InputLine();
    l.insert('helo');
    expect(l.value).toBe('helo');
    expect(l.cursorPos).toBe(4);
    l.left();
    l.insert('l'); // fix "helo" → "hello"
    expect(l.value).toBe('hello');
    expect(l.cursorPos).toBe(4);
    l.end();
    l.backspace();
    expect(l.value).toBe('hell');
  });

  it('strips control chars from inserted text (paste safety)', () => {
    const l = new InputLine();
    l.insert('a\x00b\x1bc');
    expect(l.value).toBe('abc');
  });

  it('handles home/end, kill-to-start, kill-to-end, delete-forward', () => {
    const l = new InputLine();
    l.insert('abcdef');
    l.home();
    expect(l.cursorPos).toBe(0);
    l.deleteForward();
    expect(l.value).toBe('bcdef');
    l.end();
    l.killToEnd();
    expect(l.value).toBe('bcdef');
    l.home();
    l.right();
    l.killToStart();
    expect(l.value).toBe('cdef');
    expect(l.cursorPos).toBe(0);
  });

  it('submits, records history, and browses it', () => {
    const l = new InputLine();
    l.insert('first');
    expect(l.submit()).toBe('first');
    expect(l.value).toBe('');
    l.insert('second');
    l.submit();

    l.insert('dra'); // in-progress line
    l.historyPrev();
    expect(l.value).toBe('second');
    l.historyPrev();
    expect(l.value).toBe('first');
    l.historyPrev(); // clamps at oldest
    expect(l.value).toBe('first');
    l.historyNext();
    expect(l.value).toBe('second');
    l.historyNext(); // back to the stashed in-progress line
    expect(l.value).toBe('dra');
  });

  it('does not record blank or duplicate consecutive history', () => {
    const l = new InputLine();
    l.insert('  ');
    l.submit(); // blank → not recorded
    l.insert('x');
    l.submit();
    l.insert('x');
    l.submit(); // duplicate → not recorded twice
    l.historyPrev();
    expect(l.value).toBe('x');
    l.historyPrev();
    expect(l.value).toBe('x'); // only one entry
  });
});

describe('filterCommands', () => {
  const cmds: SlashCommand[] = [
    { name: '/model', desc: 'switch model' },
    { name: '/models', desc: 'list models' },
    { name: '/mcp', desc: 'servers' },
    { name: '/help', desc: 'help' },
  ];

  it('matches by prefix while a command is being typed', () => {
    expect(filterCommands(cmds, '/m').map((c) => c.name)).toEqual(['/model', '/models', '/mcp']);
    expect(filterCommands(cmds, '/mo').map((c) => c.name)).toEqual(['/model', '/models']);
    expect(filterCommands(cmds, '/').map((c) => c.name)).toHaveLength(4);
  });

  it('returns nothing for non-command input or once an argument starts', () => {
    expect(filterCommands(cmds, 'hello')).toEqual([]);
    expect(filterCommands(cmds, '/model qwen3')).toEqual([]); // space → argument typed
    expect(filterCommands(cmds, '/zzz')).toEqual([]);
  });
});
