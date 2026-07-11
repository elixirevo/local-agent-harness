import { displayWidth } from './ansi.js';

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
 * terminal I/O): the TUI calls update() with the current input, moves the
 * selection with next()/prev(), and reads selected/index to render and to
 * fill the input on Enter. The selection resets whenever the filter changes.
 */
export class HintMenu {
  private items: SlashCommand[] = [];
  private idx = 0;
  private filterKey: string | null = null;

  update(commands: SlashCommand[], input: string): void {
    this.items = filterCommands(commands, input);
    if (input !== this.filterKey) {
      this.idx = 0;
      this.filterKey = input;
    }
    if (this.idx >= this.items.length) this.idx = 0;
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
