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
