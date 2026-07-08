import type { Approval } from '../permissions/gate.js';
import { bold, cyan, dim, green, red } from './ansi.js';
import { filterCommands, InputLine, type SlashCommand } from './editor.js';
import type { ReplUi } from './ui.js';

const WAIT_DELAY_MS = 150;
const WAIT_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const PROMPT = '❯ ';
const MIN_ROWS = 4;

export function canUseRawTui(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY) && (process.stdout.rows ?? 0) >= MIN_ROWS;
}

/**
 * Raw-mode terminal UI with a pinned bottom input. Layout for a terminal of
 * height H: rows 1..H-2 are a DECSTBM scroll region that model/tool output
 * flows into (scrolling up into scrollback), row H-1 is the input line, row H
 * is the hint/status line. Output and the input bar never share a row, so the
 * approval prompt can never be obscured by streaming output.
 *
 * The one subtle invariant: the output append position lives in the DEC
 * cursor-save slot (\x1b7/\x1b8) and NOTHING else uses that slot — the bar is
 * drawn with absolute cursor moves. So each write restores the exact output
 * position (even across scrolls), appends, re-saves, then repaints the bar.
 */
export class RawTui implements ReplUi {
  readonly interactive = true;
  private readonly stdin = process.stdin;
  private readonly out = process.stdout;
  private rows: number;
  private cols: number;
  private readonly input = new InputLine();
  private readonly queue: string[] = [];
  private lineResolver: ((v: string | undefined) => void) | null = null;
  private askResolver: ((a: Approval) => void) | null = null;
  private askAllowAlways = false;
  private interruptFn: (() => void) | undefined;
  private working = false;
  private waitTimer: NodeJS.Timeout | undefined;
  private waitAnim: NodeJS.Timeout | undefined;
  private waitStart = 0;
  private frame = 0;
  private closed = false;
  private readonly onData = (d: string) => this.handleData(d);
  private readonly onResize = () => this.handleResize();
  private readonly onExit = () => this.restoreTerminal();

  constructor(private readonly slashCommands: SlashCommand[]) {
    this.rows = this.out.rows ?? 24;
    this.cols = this.out.columns ?? 80;
    this.stdin.setRawMode?.(true);
    this.stdin.resume();
    this.stdin.setEncoding('utf8');
    this.stdin.on('data', this.onData);
    this.out.on('resize', this.onResize);
    // Safety net: if the process exits/crashes before close(), still undo the
    // scroll region and raw mode so the user's terminal isn't left broken.
    process.once('exit', this.onExit);
    this.setupScreen();
  }

  /** Idempotent terminal restore (scroll region, raw mode, cursor). */
  private restoreTerminal(): void {
    this.stdin.setRawMode?.(false);
    this.out.write(`\x1b[r\x1b[${this.rows};1H\x1b[?25h`);
  }

  private setupScreen(): void {
    // Scroll region = rows 1..H-2; park the output cursor at its bottom.
    this.out.write(`\x1b[1;${this.rows - 2}r`);
    this.out.write(`\x1b[${this.rows - 2};1H\x1b7`);
    this.drawBar();
  }

  write(s: string): void {
    if (this.closed || !s) return;
    this.out.write('\x1b[?25l'); // hide cursor during the jump to avoid flicker
    this.out.write('\x1b8'); // restore output position
    this.out.write(s);
    this.out.write('\x1b7'); // save new output position
    this.drawBar();
    this.out.write('\x1b[?25h');
  }

  readLine(_prompt: string): Promise<string | undefined> {
    const queued = this.queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.closed) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      this.lineResolver = resolve;
    });
  }

  ask(summary: string, allowAlways: boolean): Promise<Approval> {
    const opts = allowAlways ? '[y]es / [n]o / [a]lways' : '[y]es / [n]o';
    this.write(`${bold('approve?')} ${summary} — ${opts}\n`);
    return new Promise((resolve) => {
      this.askResolver = resolve;
      this.askAllowAlways = allowAlways;
      this.drawBar();
    });
  }

  beginWait(_canDraw: boolean): void {
    if (this.closed || this.working || this.waitTimer) return;
    this.waitTimer = setTimeout(() => {
      this.working = true;
      this.waitStart = Date.now();
      this.waitAnim = setInterval(() => {
        this.frame = (this.frame + 1) % WAIT_FRAMES.length;
        this.drawBar();
      }, 120);
      this.drawBar();
    }, WAIT_DELAY_MS);
  }

  endWait(): void {
    if (this.waitTimer) clearTimeout(this.waitTimer);
    if (this.waitAnim) clearInterval(this.waitAnim);
    this.waitTimer = undefined;
    this.waitAnim = undefined;
    if (this.working) {
      this.working = false;
      this.drawBar();
    }
  }

  onIdle(): void {
    this.drawBar();
  }

  onInterrupt(fn: () => void): void {
    this.interruptFn = fn;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.endWait();
    this.stdin.off('data', this.onData);
    this.out.off('resize', this.onResize);
    process.off('exit', this.onExit);
    this.restoreTerminal();
    this.out.write('\n');
    this.stdin.pause();
    this.lineResolver?.(undefined);
    this.lineResolver = null;
  }

  // ---- input handling ----

  private handleData(data: string): void {
    if (this.askResolver) {
      this.handleAskKey(data);
      return;
    }
    let i = 0;
    while (i < data.length) {
      const ch = data[i];
      if (ch === '\x1b') {
        i += this.handleEscape(data.slice(i));
      } else if (ch === '\r' || ch === '\n') {
        this.submitLine();
        i++;
      } else if (ch === '\x7f' || ch === '\b') {
        this.input.backspace();
        i++;
      } else if (ch === '\x03') {
        this.interruptFn?.();
        i++;
      } else if (ch === '\x04') {
        if (this.input.value === '') this.close();
        i++;
      } else if (ch === '\x15') {
        this.input.killToStart();
        i++;
      } else if (ch === '\x0b') {
        this.input.killToEnd();
        i++;
      } else if (ch === '\x01') {
        this.input.home();
        i++;
      } else if (ch === '\x05') {
        this.input.end();
        i++;
      } else if (ch >= ' ') {
        let j = i;
        while (j < data.length && data[j] >= ' ' && data[j] !== '\x7f' && data[j] !== '\x1b') j++;
        this.input.insert(data.slice(i, j));
        i = j;
      } else {
        i++;
      }
    }
    if (!this.closed) this.drawBar();
  }

  /** Handle an escape sequence at the start of `s`; return bytes consumed. */
  private handleEscape(s: string): number {
    if (s.startsWith('\x1b[A')) return this.input.historyPrev(), 3;
    if (s.startsWith('\x1b[B')) return this.input.historyNext(), 3;
    if (s.startsWith('\x1b[C')) return this.input.right(), 3;
    if (s.startsWith('\x1b[D')) return this.input.left(), 3;
    if (s.startsWith('\x1b[H') || s.startsWith('\x1b[1~')) return this.input.home(), s[2] === 'H' ? 3 : 4;
    if (s.startsWith('\x1b[F') || s.startsWith('\x1b[4~')) return this.input.end(), s[2] === 'F' ? 3 : 4;
    if (s.startsWith('\x1b[3~')) return this.input.deleteForward(), 4;
    // Unknown escape: consume the CSI sequence up to its final letter, or just ESC.
    const m = s.match(/^\x1b\[[0-9;]*[A-Za-z~]/);
    return m ? m[0].length : 1;
  }

  private handleAskKey(data: string): void {
    const ch = (data[0] ?? '').toLowerCase();
    let ans: Approval | null = null;
    if (ch === 'y') ans = 'once';
    else if (ch === 'a' && this.askAllowAlways) ans = 'always';
    else if (ch === 'n' || ch === '\r' || ch === '\n' || ch === '\x03') ans = 'deny';
    else return; // ignore other keys; keep waiting
    const label = ans === 'deny' ? red('✗ denied') : ans === 'always' ? green('✓ allowed (always)') : green('✓ allowed');
    this.write(`  ${label}\n`);
    const resolve = this.askResolver!;
    this.askResolver = null;
    this.askAllowAlways = false;
    this.drawBar();
    resolve(ans);
  }

  private submitLine(): void {
    const line = this.input.submit();
    if (line.trim()) this.write(`${cyan(PROMPT)}${line}\n`);
    if (this.lineResolver) {
      const resolve = this.lineResolver;
      this.lineResolver = null;
      resolve(line);
    } else if (line.trim()) {
      this.queue.push(line);
    }
  }

  // ---- rendering ----

  private drawBar(): void {
    if (this.closed) return;
    const inputRow = this.rows - 1;
    const hintRow = this.rows;
    const { text, cursorCol } = this.renderInput();
    let out = '\x1b[?25l';
    out += `\x1b[${inputRow};1H\x1b[2K${text}`;
    out += `\x1b[${hintRow};1H\x1b[2K${this.renderHint()}`;
    out += `\x1b[${inputRow};${cursorCol}H\x1b[?25h`;
    this.out.write(out);
  }

  private renderInput(): { text: string; cursorCol: number } {
    const avail = Math.max(8, this.cols - PROMPT.length - 1);
    const value = this.input.value;
    const cursor = this.input.cursorPos;
    if (value.length <= avail) {
      return { text: cyan(PROMPT) + value, cursorCol: PROMPT.length + cursor + 1 };
    }
    // Horizontal scroll so the cursor stays visible; mark truncation with ….
    let start = Math.max(0, cursor - avail + 1);
    const window = value.slice(start, start + avail);
    const shownCol = PROMPT.length + (cursor - start) + 1;
    const prefix = start > 0 ? dim('…') : '';
    return { text: cyan(PROMPT) + prefix + window.slice(prefix ? 1 : 0), cursorCol: shownCol };
  }

  private renderHint(): string {
    if (this.askResolver) {
      return dim(`press y / n${this.askAllowAlways ? ' / a (always allow this tool this session)' : ''}`);
    }
    const matches = filterCommands(this.slashCommands, this.input.value);
    if (matches.length > 0) {
      const list = matches
        .slice(0, 6)
        .map((c) => (matches.length === 1 ? `${c.name} — ${c.desc}` : c.name))
        .join('  ');
      return truncate(dim(list), this.cols);
    }
    if (this.working) {
      const elapsed = ((Date.now() - this.waitStart) / 1000).toFixed(1);
      return dim(`${WAIT_FRAMES[this.frame]} working… ${elapsed}s   (ctrl+c to interrupt)`);
    }
    return dim('enter send · / for commands · ↑↓ history · ctrl+c interrupt');
  }

  private handleResize(): void {
    this.rows = this.out.rows ?? 24;
    this.cols = this.out.columns ?? 80;
    if (this.rows < MIN_ROWS) return;
    this.out.write(`\x1b[1;${this.rows - 2}r`);
    this.out.write(`\x1b[${this.rows - 2};1H\x1b7`);
    this.drawBar();
  }
}

/** Truncate a possibly-ANSI-colored string to fit `width` visible columns. */
function truncate(s: string, width: number): string {
  const visible = s.replace(/\x1b\[[0-9;]*m/g, '');
  if (visible.length <= width) return s;
  // Colored hints are a single dim(...) wrap; slice the inner text safely.
  const inner = visible.slice(0, width - 1);
  return dim(inner + '…');
}
