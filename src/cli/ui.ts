import * as readline from 'node:readline/promises';
import type { Approval } from '../permissions/gate.js';
import { bold, dim, useColor } from './ansi.js';
import type { SlashCommand } from './editor.js';

/**
 * The surface the REPL renders through. Two implementations: the plain
 * line-by-line writer (piped stdin, one-shot, or --plain) and the raw-mode
 * RawTui with a pinned bottom input. Keeping the REPL on this interface lets
 * both coexist without the orchestration knowing which is active.
 */
export interface ReplUi {
  /** True when a user can be prompted (a TTY, or --plain on a TTY). */
  readonly interactive: boolean;
  /** Write model/tool output into the scroll area. */
  write(s: string): void;
  /** Read one line of user input; undefined at EOF/close. */
  readLine(prompt: string): Promise<string | undefined>;
  /** Approve a mutating call (y/n, or y/n/a when allowAlways). */
  ask(summary: string, allowAlways: boolean): Promise<Approval>;
  /** Pick one item from a list; resolves to its index, or undefined if cancelled. */
  choose(title: string, items: SlashCommand[]): Promise<number | undefined>;
  /** Show/hide a "working" indicator during silent gaps. */
  beginWait(canDraw: boolean): void;
  endWait(): void;
  /** Called when a turn boundary is reached (idle) — refresh any status. */
  onIdle(): void;
  /** Register the interrupt handler (Ctrl+C): abort a turn, else close. */
  onInterrupt(fn: () => void): void;
  close(): void;
}

const write = (s: string) => process.stdout.write(s);

/**
 * A transient "working…" line for silent gaps (tool execution, prefill,
 * compaction). Armed before every awaited event but drawn only after a short
 * delay, so a fast token stream never triggers it. Plain-mode only.
 */
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_DELAY_MS = 150;

export class Spinner {
  private armTimer: NodeJS.Timeout | undefined;
  private tick: NodeJS.Timeout | undefined;
  private drawn = false;
  private frame = 0;
  private startedAt = 0;
  private readonly enabled = Boolean(process.stdout.isTTY) && useColor;

  arm(canDraw: boolean): void {
    if (!this.enabled || !canDraw) return;
    this.startedAt = Date.now();
    this.armTimer = setTimeout(() => {
      this.drawn = true;
      this.tick = setInterval(() => this.render(), 90);
      this.render();
    }, SPINNER_DELAY_MS);
  }

  disarm(): void {
    if (this.armTimer) clearTimeout(this.armTimer);
    if (this.tick) clearInterval(this.tick);
    this.armTimer = undefined;
    this.tick = undefined;
    if (this.drawn) {
      write('\r\x1b[K');
      this.drawn = false;
    }
  }

  private render(): void {
    const elapsed = ((Date.now() - this.startedAt) / 1000).toFixed(1);
    this.frame = (this.frame + 1) % SPINNER_FRAMES.length;
    write(`\r\x1b[K${dim(`${SPINNER_FRAMES[this.frame]} working… ${elapsed}s`)}`);
  }
}

/**
 * Sequential line source over readline. Lines that arrive while a turn is
 * being processed (always the case for piped stdin) are queued instead of
 * dropped. Both the main loop and permission prompts pull from this one queue.
 */
export class LineReader {
  private queue: string[] = [];
  private waiter: ((v: string | undefined) => void) | null = null;
  private closed = false;
  private beforePrompt: (() => void) | undefined;

  constructor(
    private readonly rl: readline.Interface,
    private readonly interactive: boolean,
  ) {
    rl.on('line', (line: string) => {
      if (this.waiter) {
        const w = this.waiter;
        this.waiter = null;
        w(line);
      } else {
        this.queue.push(line);
      }
    });
    rl.on('close', () => {
      this.closed = true;
      if (this.waiter) {
        const w = this.waiter;
        this.waiter = null;
        w(undefined);
      }
    });
  }

  onBeforePrompt(fn: () => void): void {
    this.beforePrompt = fn;
  }

  next(promptText: string): Promise<string | undefined> {
    const queued = this.queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.closed) return Promise.resolve(undefined);
    if (this.interactive) {
      this.beforePrompt?.();
      this.rl.setPrompt(promptText);
      this.rl.prompt();
    }
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }
}

/** Line-by-line UI: piped stdin, one-shot, or --plain on a TTY. */
export class PlainUi implements ReplUi {
  readonly interactive: boolean;
  private readonly reader: LineReader;
  private readonly spinner = new Spinner();

  constructor(rl: readline.Interface, interactive: boolean) {
    this.interactive = interactive;
    this.reader = new LineReader(rl, interactive);
    this.reader.onBeforePrompt(() => this.spinner.disarm());
    this.rl = rl;
  }

  private readonly rl: readline.Interface;

  write(s: string): void {
    write(s);
  }

  readLine(prompt: string): Promise<string | undefined> {
    return this.reader.next(prompt);
  }

  async ask(summary: string, allowAlways: boolean): Promise<Approval> {
    const opts = allowAlways ? '[y/n/a]' : '[y/n]';
    const answer = (await this.reader.next(`${bold('allow')} ${summary}? ${opts} `) ?? '')
      .trim()
      .toLowerCase();
    if (answer === 'a' || answer === 'always') return allowAlways ? 'always' : 'once';
    if (answer === 'y' || answer === 'yes') return 'once';
    return 'deny';
  }

  async choose(title: string, items: SlashCommand[]): Promise<number | undefined> {
    if (items.length === 0) return undefined;
    this.write(`${bold(title)}\n`);
    items.forEach((c, i) => this.write(`  ${i + 1}. ${c.name}  ${dim(c.desc)}\n`));
    const answer = ((await this.reader.next('number (empty to cancel): ')) ?? '').trim();
    const n = Number(answer);
    return Number.isInteger(n) && n >= 1 && n <= items.length ? n - 1 : undefined;
  }

  beginWait(canDraw: boolean): void {
    this.spinner.arm(canDraw);
  }

  endWait(): void {
    this.spinner.disarm();
  }

  onIdle(): void {}

  onInterrupt(fn: () => void): void {
    this.rl.on('SIGINT', fn);
  }

  close(): void {
    this.spinner.disarm();
    this.rl.close();
  }
}
