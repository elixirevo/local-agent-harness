import type { Approval } from '../permissions/gate.js';
import { bold, cyan, dim, displayWidth, green, red, truncateAnsi } from './ansi.js';
import { computeMultilineView, HintMenu, InputLine, renderMenuRows, type SlashCommand } from './editor.js';
import type { ReplUi } from './ui.js';

const WAIT_DELAY_MS = 150;
const WAIT_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const PROMPT = '❯ ';
const MIN_ROWS = 10;
const MAX_MENU_ROWS = 6;
const MAX_INPUT_ROWS = 5;
const PROMPT_CONT = '  ';

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
  private readonly menu = new HintMenu();
  private readonly queue: string[] = [];
  /** Last row of the scroll region; the bar area starts right below it. */
  private regionTop: number;
  private choosing: {
    title: string;
    items: SlashCommand[];
    idx: number;
    resolve: (i: number | undefined) => void;
  } | null = null;
  /** Accumulates a bracketed paste until its terminator arrives. */
  private pasting: string | null = null;
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
    // Default bar: spacer + 1 input row + spacer + hint row.
    this.regionTop = this.rows - 4;
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

  /** Idempotent terminal restore (scroll region, raw mode, cursor, modes). */
  private restoreTerminal(): void {
    this.stdin.setRawMode?.(false);
    this.out.write(`\x1b[?2004l\x1b[>4;0m\x1b[r\x1b[${this.rows};1H\x1b[?25h`);
  }

  private setupScreen(): void {
    // Bracketed paste (multiline pastes arrive as one tagged chunk) and
    // xterm modifyOtherKeys level 1 (shift+enter becomes distinguishable).
    this.out.write('\x1b[?2004h\x1b[>4;1m');
    // Scroll region = rows 1..regionTop; park the output cursor at its bottom.
    this.out.write(`\x1b[1;${this.regionTop}r`);
    this.out.write(`\x1b[${this.regionTop};1H\x1b7`);
    this.drawBar();
  }

  /**
   * Move the scroll-region bottom while keeping the output anchor on its
   * line. Shrinking walks the anchor down k rows (scrolling the old region
   * only as far as needed) and back up k — it lands on the same content line,
   * now guaranteed to sit inside the smaller region. Growing just clears the
   * rows that rejoin the region (they held stale bar content).
   */
  private moveRegionTop(newTop: number): string {
    const cur = this.regionTop;
    if (newTop === cur) return '';
    this.regionTop = newTop;
    if (newTop < cur) {
      const k = cur - newTop;
      return `\x1b8${'\n'.repeat(k)}\x1b[${k}A\x1b7\x1b[1;${newTop}r`;
    }
    let seq = `\x1b[1;${newTop}r`;
    for (let r = cur + 1; r <= newTop; r++) seq += `\x1b[${r};1H\x1b[2K`;
    return seq;
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

  choose(title: string, items: SlashCommand[]): Promise<number | undefined> {
    if (this.closed || items.length === 0) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      this.choosing = {
        title,
        items,
        idx: 0,
        resolve: (v) => {
          this.choosing = null;
          this.drawBar();
          resolve(v);
        },
      };
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
    this.choosing?.resolve(undefined);
    this.lineResolver?.(undefined);
    this.lineResolver = null;
  }

  // ---- input handling ----

  private handleData(data: string): void {
    if (this.askResolver) {
      this.handleAskKey(data);
      return;
    }
    if (this.choosing) {
      this.handleChooseKey(data);
      return;
    }
    if (this.pasting !== null) {
      this.pasting += data;
      const end = this.pasting.indexOf('\x1b[201~');
      if (end === -1) return; // terminator may arrive in a later chunk
      this.input.paste(this.pasting.slice(0, end));
      const rest = this.pasting.slice(end + 6);
      this.pasting = null;
      if (rest) {
        this.handleData(rest);
        return;
      }
      this.drawBar();
      return;
    }
    let i = 0;
    while (i < data.length) {
      const ch = data[i];
      if (ch === '\x1b') {
        const consumed = this.handleEscape(data.slice(i));
        if (this.pasting !== null) {
          // A paste just started; the rest of this chunk belongs to it.
          this.handleData(data.slice(i + consumed));
          return;
        }
        i += consumed;
      } else if (ch === '\r' || ch === '\n') {
        this.submitLine();
        i++;
      } else if (ch === '\x7f' || ch === '\b') {
        this.input.backspace();
        i++;
      } else if (ch === '\t') {
        this.menuMove('next');
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
    // Line breaks: alt/option+enter (ESC CR), shift/ctrl+enter as CSI-u or
    // xterm modifyOtherKeys encodings.
    if (s.startsWith('\x1b\r') || s.startsWith('\x1b\n')) return this.input.insertNewline(), 2;
    if (s.startsWith('\x1b[13;2u') || s.startsWith('\x1b[13;5u')) return this.input.insertNewline(), 7;
    if (s.startsWith('\x1b[27;2;13~') || s.startsWith('\x1b[27;5;13~')) return this.input.insertNewline(), 10;
    if (s.startsWith('\x1b[200~')) {
      this.pasting = '';
      return 6;
    }
    if (s.startsWith('\x1b[A')) return this.upDown('prev'), 3;
    if (s.startsWith('\x1b[B')) return this.upDown('next'), 3;
    if (s.startsWith('\x1b[Z')) return this.menuMove('prev'), 3; // shift+tab
    if (s.startsWith('\x1b[C')) return this.input.right(), 3;
    if (s.startsWith('\x1b[D')) return this.input.left(), 3;
    if (s.startsWith('\x1b[H') || s.startsWith('\x1b[1~')) return this.input.home(), s[2] === 'H' ? 3 : 4;
    if (s.startsWith('\x1b[F') || s.startsWith('\x1b[4~')) return this.input.end(), s[2] === 'F' ? 3 : 4;
    if (s.startsWith('\x1b[3~')) return this.input.deleteForward(), 4;
    // Unknown escape: consume the CSI sequence up to its final letter, or just ESC.
    const m = s.match(/^\x1b\[[0-9;]*[A-Za-z~]/);
    return m ? m[0].length : 1;
  }

  private handleChooseKey(data: string): void {
    const c = this.choosing!;
    if (data.startsWith('\x1b[A') || data.startsWith('\x1b[Z')) {
      c.idx = (c.idx - 1 + c.items.length) % c.items.length;
    } else if (data.startsWith('\x1b[B') || data.startsWith('\t')) {
      c.idx = (c.idx + 1) % c.items.length;
    } else if (data.startsWith('\r') || data.startsWith('\n')) {
      c.resolve(c.idx);
      return;
    } else if (data === '\x1b' || data.startsWith('\x03') || data.toLowerCase().startsWith('q')) {
      c.resolve(undefined);
      return;
    }
    this.drawBar();
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

  /** Keep the hint menu in sync with the current input text. */
  private syncMenu(): void {
    this.menu.update(this.slashCommands, this.input.value);
  }

  /** ↑/↓: hint menu when open, then multiline cursor movement, then history. */
  private upDown(dir: 'prev' | 'next'): void {
    this.syncMenu();
    if (this.menu.active) {
      dir === 'prev' ? this.menu.prev() : this.menu.next();
    } else if (dir === 'prev' ? this.input.lineUp() : this.input.lineDown()) {
      // moved within a multiline buffer
    } else {
      dir === 'prev' ? this.input.historyPrev() : this.input.historyNext();
    }
  }

  /** Tab / shift+tab: cycle the menu selection; no-op when the menu is closed. */
  private menuMove(dir: 'prev' | 'next'): void {
    this.syncMenu();
    if (this.menu.active) dir === 'prev' ? this.menu.prev() : this.menu.next();
  }

  private submitLine(): void {
    // With the hint menu open, Enter first completes the selection into the
    // input; a second Enter (input now equals the selection) submits it.
    this.syncMenu();
    const selected = this.menu.selected;
    if (this.menu.active && selected && this.input.value !== selected.name) {
      this.input.replace(selected.name);
      return;
    }
    // Universal line-break fallback: a trailing backslash continues the line.
    if (this.input.value.endsWith('\\')) {
      this.input.replace(this.input.value.slice(0, -1) + '\n');
      return;
    }
    const line = this.input.submit();
    if (line.trim()) this.write(`${cyan(PROMPT)}${line.replace(/\n/g, `\n${dim(PROMPT_CONT)}`)}\n`);
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
    this.syncMenu();
    // Bar layout, top to bottom: rule line · input rows (one per buffer
    // line) · rule line · N vertical menu rows or the hint row. The scroll
    // region shrinks/grows to make room.
    const menuItems = this.choosing ? this.choosing.items : this.askResolver ? [] : this.menu.matches;
    const selIdx = this.choosing ? this.choosing.idx : this.menu.index;
    const view = this.choosing
      ? null
      : computeMultilineView(
          this.input.value,
          this.input.cursorPos,
          this.cols,
          displayWidth(PROMPT),
          Math.max(1, Math.min(MAX_INPUT_ROWS, this.rows - 8)),
        );
    const inputRows = view ? view.rows.length : 1;
    const maxMenu = Math.max(1, Math.min(MAX_MENU_ROWS, this.rows - inputRows - 7));
    const menuCount = Math.min(menuItems.length, maxMenu);
    let out = '\x1b[?25l';
    out += this.moveRegionTop(this.rows - (1 + inputRows + 1 + Math.max(1, menuCount)));
    const rule = dim('─'.repeat(this.cols));
    const ruleTop = this.regionTop + 1;
    const inputTop = ruleTop + 1;
    const ruleBottom = inputTop + inputRows;
    const hintTop = ruleBottom + 1;
    out += `\x1b[${ruleTop};1H\x1b[2K${rule}`;
    let cursorRow = inputTop;
    let cursorCol = 1;
    if (this.choosing) {
      const title = truncateAnsi(
        `${bold(this.choosing.title)} ${dim('· ↑↓ select · enter confirm · esc cancel')}`,
        this.cols,
      );
      out += `\x1b[${inputTop};1H\x1b[2K${title}`;
    } else {
      view!.rows.forEach((text, i) => {
        const prefix = view!.startLine + i === 0 ? cyan(PROMPT) : dim(PROMPT_CONT);
        out += `\x1b[${inputTop + i};1H\x1b[2K${prefix}${text}`;
      });
      cursorRow = inputTop + view!.cursorRow;
      cursorCol = view!.cursorCol;
    }
    out += `\x1b[${ruleBottom};1H\x1b[2K${rule}`;
    if (menuCount > 0) {
      const enterLabel = this.choosing
        ? 'select'
        : this.menu.selected && this.input.value === this.menu.selected.name
          ? 'run'
          : 'fill';
      const lines = renderMenuRows(menuItems, selIdx, maxMenu, this.cols, enterLabel);
      lines.forEach((line, i) => {
        out += `\x1b[${hintTop + i};1H\x1b[2K${line}`;
      });
    } else {
      out += `\x1b[${hintTop};1H\x1b[2K${this.renderHint()}`;
    }
    out += `\x1b[${cursorRow};${cursorCol}H\x1b[?25h`;
    this.out.write(out);
  }

  private renderHint(): string {
    if (this.askResolver) {
      return dim(`press y / n${this.askAllowAlways ? ' / a (always allow this tool this session)' : ''}`);
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
    // Reset to the default layout and re-park; drawBar re-shrinks for any
    // open menu/multiline input from this known-good state.
    this.regionTop = this.rows - 4;
    this.out.write(`\x1b[1;${this.regionTop}r`);
    this.out.write(`\x1b[${this.regionTop};1H\x1b7`);
    this.drawBar();
  }
}
