import { describe, expect, it } from 'vitest';
import { charWidth, displayWidth, truncateAnsi } from '../src/cli/ansi.js';
import { computeInputView, filterCommands, HintMenu, InputLine, type SlashCommand } from '../src/cli/editor.js';

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

describe('displayWidth (CJK-aware)', () => {
  it('counts Hangul and CJK as 2 columns, ASCII as 1', () => {
    expect(charWidth('a'.codePointAt(0)!)).toBe(1);
    expect(charWidth('가'.codePointAt(0)!)).toBe(2); // composed Hangul syllable
    expect(charWidth('中'.codePointAt(0)!)).toBe(2);
    expect(displayWidth('안녕')).toBe(4);
    expect(displayWidth('hi 안녕')).toBe(3 + 4);
    expect(displayWidth('')).toBe(0);
  });
});

describe('computeInputView (cursor column math)', () => {
  const promptW = 2; // "❯ "

  it('places the cursor by column width, not char count, for Hangul', () => {
    // "안녕" = 4 columns; cursor after both chars sits at prompt(2)+4+1 = 7.
    const v = computeInputView('안녕', 2, 80, promptW);
    expect(v.leftTrunc).toBe(false);
    expect(v.visible).toBe('안녕');
    expect(v.cursorCol).toBe(7);
    // cursor between the two syllables → prompt(2)+2+1 = 5
    expect(computeInputView('안녕', 1, 80, promptW).cursorCol).toBe(5);
  });

  it('mixes ASCII and Hangul widths correctly', () => {
    // "ab가" → widths 1,1,2; cursor at end → 2 + 4 + 1 = 7
    expect(computeInputView('ab가', 3, 80, promptW).cursorCol).toBe(7);
  });

  it('horizontally scrolls a long Hangul line without exceeding the width', () => {
    const long = '가'.repeat(40); // 80 columns of Hangul
    const view = computeInputView(long, 40, 20, promptW);
    expect(view.leftTrunc).toBe(true);
    // visible portion must fit the available columns (cols - prompt - 1)
    expect(displayWidth(view.visible) + 1 /* … */).toBeLessThanOrEqual(20 - promptW);
    // cursor stays within the terminal
    expect(view.cursorCol).toBeLessThanOrEqual(20);
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

describe('HintMenu (keyboard-selectable hint bar)', () => {
  const cmds: SlashCommand[] = [
    { name: '/model', desc: 'switch model' },
    { name: '/models', desc: 'list models' },
    { name: '/mcp', desc: 'servers' },
    { name: '/help', desc: 'help' },
  ];

  it('is inactive without matches and selects the first match by default', () => {
    const m = new HintMenu();
    m.update(cmds, 'hello');
    expect(m.active).toBe(false);
    expect(m.selected).toBeUndefined();
    m.update(cmds, '/m');
    expect(m.active).toBe(true);
    expect(m.selected?.name).toBe('/model');
  });

  it('cycles the selection with next/prev, wrapping at the ends', () => {
    const m = new HintMenu();
    m.update(cmds, '/m');
    m.next();
    expect(m.selected?.name).toBe('/models');
    m.next();
    m.next(); // wraps past /mcp
    expect(m.selected?.name).toBe('/model');
    m.prev(); // wraps back to the end
    expect(m.selected?.name).toBe('/mcp');
  });

  it('keeps the selection while the filter is unchanged, resets when it changes', () => {
    const m = new HintMenu();
    m.update(cmds, '/m');
    m.next();
    m.update(cmds, '/m'); // redraw with same input
    expect(m.selected?.name).toBe('/models');
    m.update(cmds, '/mo'); // filter changed
    expect(m.index).toBe(0);
    expect(m.selected?.name).toBe('/model');
  });

  it('completing to the selected name keeps it selected (Enter-Enter submits)', () => {
    const m = new HintMenu();
    m.update(cmds, '/mo');
    // Enter fills '/model'; the menu re-filters on the completed text.
    m.update(cmds, '/model');
    expect(m.selected?.name).toBe('/model'); // exact match stays first → submit works
  });
});

describe('InputLine.replace (hint-menu completion)', () => {
  it('replaces the buffer and puts the cursor at the end', () => {
    const l = new InputLine();
    l.insert('/mo');
    l.left();
    l.replace('/model');
    expect(l.value).toBe('/model');
    expect(l.cursorPos).toBe('/model'.length);
  });
});

describe('truncateAnsi', () => {
  it('returns short strings unchanged, escapes and all', () => {
    const s = '\x1b[2mhi\x1b[0m';
    expect(truncateAnsi(s, 10)).toBe(s);
  });

  it('truncates by display width, not char count (CJK)', () => {
    const out = truncateAnsi('한글메뉴테스트', 8); // 7 chars but 14 columns
    expect(out.endsWith('…')).toBe(true);
    expect(displayWidth(out.replace(/\x1b\[[0-9;]*m/g, ''))).toBeLessThanOrEqual(8);
  });

  it('preserves escape sequences and closes color before the marker', () => {
    const out = truncateAnsi('\x1b[7m/model\x1b[0m  \x1b[2m/models\x1b[0m', 10);
    expect(out).toContain('\x1b[7m');
    expect(out.endsWith('\x1b[0m…')).toBe(true);
  });
});
