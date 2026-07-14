import { dim, displayWidth, inverse, truncateAnsi } from './ansi.js';

export interface InputView {
  /** Windowed value text (no prompt, no color, no … marker). */
  visible: string;
  /** True when text is hidden to the left (a … marker should precede visible). */
  leftTrunc: boolean;
  /** 1-based terminal column of the cursor, including the prompt. */
  cursorCol: number;
}

/**
 * Compute the visible slice of an input line and the cursor column, in
 * terminal COLUMNS (wide CJK/Hangul chars are 2 columns). Pure so the
 * width math — which broke Hangul cursor placement — is unit-testable.
 */
export function computeInputView(value: string, cursor: number, cols: number, promptWidth: number): InputView {
  const avail = Math.max(8, cols - promptWidth - 1);
  const chars = [...value];
  const w = chars.map((c) => displayWidth(c));
  const widthTo = (i: number) => w.slice(0, i).reduce((a, b) => a + b, 0);
  const total = widthTo(chars.length);

  if (total <= avail) {
    return { visible: chars.join(''), leftTrunc: false, cursorCol: promptWidth + widthTo(cursor) + 1 };
  }
  // Widest window ending at the cursor that fits `avail` columns.
  let start = cursor;
  let used = 0;
  while (start > 0 && used + w[start - 1] <= avail - 1) {
    start--;
    used += w[start];
  }
  let end = cursor;
  while (end < chars.length && used + w[end] <= avail - 1) {
    used += w[end];
    end++;
  }
  const leftTrunc = start > 0;
  const visStart = leftTrunc ? start + 1 : start;
  return {
    visible: chars.slice(visStart, end).join(''),
    leftTrunc,
    cursorCol: promptWidth + (leftTrunc ? 1 : 0) + (widthTo(cursor) - widthTo(visStart)) + 1,
  };
}

export interface MultilineInputView {
  /** Visible text per input row (leading … when horizontally truncated). */
  rows: string[];
  /** Buffer line index of rows[0] (vertical window offset). */
  startLine: number;
  /** Index into `rows` of the cursor's row. */
  cursorRow: number;
  /** 1-based terminal column of the cursor, including the prompt. */
  cursorCol: number;
}

/**
 * Multiline variant of computeInputView: one visible row per buffer line,
 * vertically windowed to `maxRows` around the cursor's line; the cursor's
 * line also scrolls horizontally.
 */
export function computeMultilineView(
  value: string,
  cursor: number,
  cols: number,
  promptWidth: number,
  maxRows: number,
): MultilineInputView {
  const lines = value.split('\n');
  let line = 0;
  let col = cursor;
  while (line < lines.length - 1 && col > lines[line].length) {
    col -= lines[line].length + 1;
    line++;
  }
  const count = Math.min(lines.length, Math.max(1, maxRows));
  const start = Math.max(0, Math.min(line - Math.floor(count / 2), lines.length - count));
  let cursorCol = promptWidth + 1;
  const rows = lines.slice(start, start + count).map((ln, i) => {
    const isCursorLine = start + i === line;
    const v = computeInputView(ln, isCursorLine ? col : 0, cols, promptWidth);
    if (isCursorLine) cursorCol = v.cursorCol;
    return (v.leftTrunc ? '…' : '') + v.visible;
  });
  return { rows, startLine: start, cursorRow: line - start, cursorCol };
}

/**
 * Pure line-editor state — no terminal I/O, so the raw-mode TUI's editing
 * logic is unit-testable. The TUI feeds it keys and renders `value`/`cursor`.
 */
export class InputLine {
  private buffer = '';
  private cursor = 0;
  private readonly history: string[] = [];
  /** null = editing the live line; otherwise an index into history. */
  private histIdx: number | null = null;
  /** The live line stashed while browsing history. */
  private stash = '';

  get value(): string {
    return this.buffer;
  }

  get cursorPos(): number {
    return this.cursor;
  }

  insert(text: string): void {
    // Drop control chars; keep printable text (including pasted multi-char).
    const clean = [...text].filter((ch) => ch >= ' ' || ch === '\t').join('');
    if (!clean) return;
    this.buffer = this.buffer.slice(0, this.cursor) + clean + this.buffer.slice(this.cursor);
    this.cursor += clean.length;
  }

  /** Insert a line break at the cursor (shift+enter / backslash continuation). */
  insertNewline(): void {
    this.buffer = this.buffer.slice(0, this.cursor) + '\n' + this.buffer.slice(this.cursor);
    this.cursor++;
  }

  /** Insert pasted text, keeping its line breaks (bracketed paste). */
  paste(text: string): void {
    const clean = [...text.replace(/\r\n?/g, '\n')].filter((ch) => ch >= ' ' || ch === '\t' || ch === '\n').join('');
    if (!clean) return;
    this.buffer = this.buffer.slice(0, this.cursor) + clean + this.buffer.slice(this.cursor);
    this.cursor += clean.length;
  }

  /** Cursor's line index and column within the (possibly multiline) buffer. */
  private lineCol(): { line: number; col: number; lines: string[] } {
    const lines = this.buffer.split('\n');
    let line = 0;
    let col = this.cursor;
    while (line < lines.length - 1 && col > lines[line].length) {
      col -= lines[line].length + 1;
      line++;
    }
    return { line, col, lines };
  }

  /** Move the cursor one line up; false when already on the first line. */
  lineUp(): boolean {
    const { line, col, lines } = this.lineCol();
    if (line === 0) return false;
    const target = Math.min(col, lines[line - 1].length);
    this.cursor = lines.slice(0, line - 1).reduce((a, l) => a + l.length + 1, 0) + target;
    return true;
  }

  /** Move the cursor one line down; false when already on the last line. */
  lineDown(): boolean {
    const { line, col, lines } = this.lineCol();
    if (line >= lines.length - 1) return false;
    const target = Math.min(col, lines[line + 1].length);
    this.cursor = lines.slice(0, line + 1).reduce((a, l) => a + l.length + 1, 0) + target;
    return true;
  }

  backspace(): void {
    if (this.cursor === 0) return;
    this.buffer = this.buffer.slice(0, this.cursor - 1) + this.buffer.slice(this.cursor);
    this.cursor--;
  }

  deleteForward(): void {
    if (this.cursor >= this.buffer.length) return;
    this.buffer = this.buffer.slice(0, this.cursor) + this.buffer.slice(this.cursor + 1);
  }

  left(): void {
    if (this.cursor > 0) this.cursor--;
  }

  right(): void {
    if (this.cursor < this.buffer.length) this.cursor++;
  }

  home(): void {
    this.cursor = 0;
  }

  end(): void {
    this.cursor = this.buffer.length;
  }

  killToStart(): void {
    this.buffer = this.buffer.slice(this.cursor);
    this.cursor = 0;
  }

  killToEnd(): void {
    this.buffer = this.buffer.slice(0, this.cursor);
  }

  clear(): void {
    this.buffer = '';
    this.cursor = 0;
    this.histIdx = null;
  }

  /** Replace the whole line (hint-menu completion), cursor at the end. */
  replace(text: string): void {
    this.buffer = text;
    this.cursor = text.length;
    this.histIdx = null;
  }

  /** Replace [start, end) with text (mention completion), cursor after it. */
  replaceRange(start: number, end: number, text: string): void {
    const s = Math.max(0, Math.min(start, this.buffer.length));
    const e = Math.max(s, Math.min(end, this.buffer.length));
    this.buffer = this.buffer.slice(0, s) + text + this.buffer.slice(e);
    this.cursor = s + text.length;
  }

  /** Take the current line, push non-empty to history, reset. */
  submit(): string {
    const line = this.buffer;
    if (line.trim() && this.history[this.history.length - 1] !== line) {
      this.history.push(line);
    }
    this.clear();
    return line;
  }

  historyPrev(): void {
    if (this.history.length === 0) return;
    if (this.histIdx === null) {
      this.stash = this.buffer;
      this.histIdx = this.history.length - 1;
    } else if (this.histIdx > 0) {
      this.histIdx--;
    } else {
      return;
    }
    this.setFromHistory(this.history[this.histIdx]);
  }

  historyNext(): void {
    if (this.histIdx === null) return;
    if (this.histIdx < this.history.length - 1) {
      this.histIdx++;
      this.setFromHistory(this.history[this.histIdx]);
    } else {
      this.histIdx = null;
      this.setFromHistory(this.stash);
    }
  }

  private setFromHistory(text: string): void {
    this.buffer = text;
    this.cursor = text.length;
  }
}

export interface SlashCommand {
  name: string;
  desc: string;
}

/**
 * Commands to suggest under the input for the current text. Returns matches
 * only while the line looks like a command being typed (starts with "/", no
 * space yet); otherwise nothing, and the bar shows a generic hint.
 */
export function filterCommands(commands: SlashCommand[], input: string): SlashCommand[] {
  if (!input.startsWith('/') || input.includes(' ')) return [];
  const q = input.toLowerCase();
  return commands.filter((c) => c.name.toLowerCase().startsWith(q));
}

/**
 * Keyboard-navigable selection over the hint-bar matches. Pure state (no
 * terminal I/O): the TUI supplies the current matches with set()/update(),
 * moves the selection with next()/prev(), and reads selected/index to render
 * and to fill the input on Enter. The selection resets whenever the filter
 * key changes.
 */
export class HintMenu {
  private items: SlashCommand[] = [];
  private idx = 0;
  private filterKey: string | null = null;

  /** Supply pre-filtered items; key identifies the filter for index resets. */
  set(items: SlashCommand[], key: string): void {
    this.items = items;
    if (key !== this.filterKey) {
      this.idx = 0;
      this.filterKey = key;
    }
    if (this.idx >= this.items.length) this.idx = 0;
  }

  update(commands: SlashCommand[], input: string): void {
    this.set(filterCommands(commands, input), input);
  }

  get active(): boolean {
    return this.items.length > 0;
  }

  get matches(): SlashCommand[] {
    return this.items;
  }

  get index(): number {
    return this.idx;
  }

  get selected(): SlashCommand | undefined {
    return this.items[this.idx];
  }

  next(): void {
    if (this.items.length > 0) this.idx = (this.idx + 1) % this.items.length;
  }

  prev(): void {
    if (this.items.length > 0) this.idx = (this.idx - 1 + this.items.length) % this.items.length;
  }
}

/** The whitespace-delimited token that ends at the cursor. */
export function currentToken(value: string, cursor: number): { start: number; text: string } {
  const before = value.slice(0, cursor);
  const ws = Math.max(before.lastIndexOf(' '), before.lastIndexOf('\t'), before.lastIndexOf('\n'));
  return { start: ws + 1, text: before.slice(ws + 1) };
}

export interface MentionState {
  /** Index of the '@' in the buffer. */
  start: number;
  /** Text typed after the '@', up to the cursor. */
  query: string;
}

/** An "@path" being typed at the cursor, or undefined. */
export function activeMention(value: string, cursor: number): MentionState | undefined {
  const { start, text } = currentToken(value, cursor);
  if (!text.startsWith('@') || text.startsWith('@@')) return undefined;
  return { start, query: text.slice(1) };
}

const MAX_FILE_MATCHES = 50;

/**
 * Filter mentionable paths for the query: prefix matches first, then
 * substring matches, both case-insensitive. An empty query returns the
 * head of the list.
 */
export function filterFiles(paths: string[], query: string): string[] {
  if (!query) return paths.slice(0, MAX_FILE_MATCHES);
  const q = query.toLowerCase();
  const prefix: string[] = [];
  const substr: string[] = [];
  for (const p of paths) {
    const lower = p.toLowerCase();
    if (lower.startsWith(q)) prefix.push(p);
    else if (lower.includes(q)) substr.push(p);
    if (prefix.length >= MAX_FILE_MATCHES) break;
  }
  return [...prefix, ...substr].slice(0, MAX_FILE_MATCHES);
}

/**
 * Render menu items as vertical rows — name column left, description right,
 * selected row highlighted. Slides a window of at most `maxRows` so the
 * selection stays visible; the selected row carries a position marker when
 * items overflow the window. Pure: the TUI paints the returned strings 1:1.
 */
export function renderMenuRows(
  items: SlashCommand[],
  selected: number,
  maxRows: number,
  cols: number,
  enterLabel = 'select',
): string[] {
  const count = Math.min(items.length, maxRows);
  if (count === 0) return [];
  const start = Math.max(0, Math.min(selected - Math.floor(count / 2), items.length - count));
  const win = items.slice(start, start + count);
  const nameW = Math.max(...win.map((c) => displayWidth(c.name)));
  return win.map((c, i) => {
    const pad = ' '.repeat(nameW - displayWidth(c.name));
    if (start + i !== selected) return truncateAnsi(`  ${c.name}${pad}  ${dim(c.desc)}`, cols);
    const pos = items.length > count ? ` · ${selected + 1}/${items.length}` : '';
    return truncateAnsi(`${inverse(`▸ ${c.name}${pad}`)}  ${c.desc}${dim(`  ⏎ ${enterLabel}${pos}`)}`, cols);
  });
}
