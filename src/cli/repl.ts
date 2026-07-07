import * as readline from 'node:readline/promises';
import { runTurn, type AgentEvent, type AgentSession } from '../core/loop.js';
import { effectiveContextLength, type HarnessConfig } from '../config/config.js';
import { resolveProfile } from '../models/profile.js';
import { PermissionGate, type AskFn } from '../permissions/gate.js';
import { createProvider } from '../providers/index.js';
import type { Usage } from '../providers/types.js';
import type { SessionStore } from '../session/store.js';

export interface CliSession extends AgentSession {
  providerName: string;
  config: HarnessConfig;
  store?: SessionStore;
}

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const dim = (s: string) => (useColor ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s: string) => (useColor ? `\x1b[1m${s}\x1b[0m` : s);
const PROMPT = useColor ? '\x1b[36m❯\x1b[0m ' : '> ';

export function friendlyFetchError(providerName: string, baseUrl: string, err: unknown): string {
  const cause = (err as { cause?: { code?: string } })?.cause;
  const code = cause?.code ? ` (${cause.code})` : '';
  const hints: Record<string, string> = {
    ollama: 'Start it with: ollama serve',
    llamacpp: 'Start it with: llama-server --jinja -m <model.gguf>',
    vllm: 'Start it with: vllm serve <model>',
  };
  return `Cannot reach ${providerName} at ${baseUrl}${code}. ${hints[providerName] ?? 'Is the server running?'}`;
}

export function formatUsage(u: Usage, wallMs: number): string {
  const parts: string[] = [`${(wallMs / 1000).toFixed(1)}s`];
  const cached = u.cachedTokens !== undefined ? ` (cached ${u.cachedTokens})` : '';
  const prefill =
    u.promptMs !== undefined ? ` in ${u.promptMs < 100 ? u.promptMs.toFixed(0) : Math.round(u.promptMs)}ms` : '';
  if (u.promptEvalTokens !== undefined) {
    parts.push(`prompt eval ${u.promptEvalTokens} tok${cached}${prefill}`);
  } else if (u.promptTokens !== undefined) {
    parts.push(`prompt ${u.promptTokens} tok${cached}${prefill}`);
  }
  if (u.completionTokens !== undefined) {
    const tps = u.tokensPerSecond !== undefined ? ` @ ${u.tokensPerSecond.toFixed(1)} tok/s` : '';
    parts.push(`gen ${u.completionTokens} tok${tps}`);
  }
  if (u.loadMs !== undefined && u.loadMs > 500) {
    parts.push(`load ${(u.loadMs / 1000).toFixed(1)}s`);
  }
  return `[${parts.join(' · ')}]`;
}

interface RenderState {
  sawThinking: boolean;
  startedText: boolean;
  atLineStart: boolean;
}

function newRenderState(): RenderState {
  return { sawThinking: false, startedText: false, atLineStart: true };
}

const write = (s: string) => process.stdout.write(s);

function ensureNewline(st: RenderState): void {
  if (!st.atLineStart) {
    write('\n');
    st.atLineStart = true;
  }
}

function renderEvent(ev: AgentEvent, st: RenderState): void {
  switch (ev.type) {
    case 'thinking':
      if (!st.sawThinking) {
        ensureNewline(st);
        write(dim('[thinking] '));
        st.sawThinking = true;
      }
      write(dim(ev.text));
      st.atLineStart = ev.text.endsWith('\n');
      break;
    case 'text':
      if (st.sawThinking && !st.startedText) {
        write('\n\n');
        st.atLineStart = true;
      }
      st.startedText = true;
      write(ev.text);
      st.atLineStart = ev.text.endsWith('\n');
      break;
    case 'tool_start':
      ensureNewline(st);
      write(dim(`→ ${ev.name} ${ev.summary}`) + '\n');
      break;
    case 'tool_end':
      write(dim(`  ${ev.ok ? '✓' : '✗'} ${ev.summary}`) + '\n');
      break;
    case 'step':
      ensureNewline(st);
      if (ev.usage) write(dim(formatUsage(ev.usage, ev.wallMs)) + '\n');
      // a new model step starts fresh for thinking/text separation
      st.sawThinking = false;
      st.startedText = false;
      break;
    case 'notice':
      ensureNewline(st);
      write(dim(`[note] ${ev.message}`) + '\n');
      break;
    case 'guard':
      ensureNewline(st);
      write(dim(`[guard] ${ev.message}`) + '\n');
      break;
  }
}

/**
 * One user turn through the agent loop. On any failure the whole turn is
 * rolled back (messages truncated to the pre-turn snapshot) so the history
 * never contains an assistant message with dangling tool calls.
 */
async function chatTurn(session: CliSession, input: string, signal?: AbortSignal): Promise<void> {
  const snapshot = session.messages.length;
  const st = newRenderState();
  try {
    for await (const ev of runTurn(session, input, signal)) renderEvent(ev, st);
    ensureNewline(st);
    session.store?.append(session.messages);
  } catch (err) {
    session.messages.length = snapshot;
    ensureNewline(st);
    if (isAbortError(err)) {
      console.log(dim('[interrupted — turn discarded]'));
      return;
    }
    throw err;
  }
}

function isAbortError(err: unknown): boolean {
  const e = err as { name?: string; code?: string };
  return e?.name === 'AbortError' || e?.code === 'ABORT_ERR';
}

function printError(session: CliSession, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('fetch failed')) {
    const cfg = session.config.providers[session.providerName];
    console.error(friendlyFetchError(session.providerName, cfg?.baseUrl ?? '?', err));
  } else {
    console.error(msg);
  }
}

export async function oneShot(session: CliSession, prompt: string): Promise<void> {
  // Non-interactive: "ask" cannot prompt, so mutations are denied with a hint.
  session.gate = new PermissionGate(session.gate.mode, session.toolCtx.cwd, undefined);
  await chatTurn(session, prompt);
}

/**
 * Sequential line source over readline. Lines that arrive while a turn is
 * being processed (always the case for piped stdin) are queued instead of
 * dropped — rl.question() alone loses them, which silently broke piped
 * multi-turn sessions. Both the main loop and permission prompts pull from
 * this one queue, so they can never race for a line.
 */
class LineReader {
  private queue: string[] = [];
  private waiter: ((v: string | undefined) => void) | null = null;
  private closed = false;

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

  /** Resolve the next line, or undefined at EOF/close. */
  next(promptText: string): Promise<string | undefined> {
    const queued = this.queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.closed) return Promise.resolve(undefined);
    if (this.interactive) {
      this.rl.setPrompt(promptText);
      this.rl.prompt();
    }
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }
}

export async function runRepl(session: CliSession): Promise<void> {
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (interactive) printBanner(session);

  const rl = readline.createInterface({
    input: process.stdin,
    output: interactive ? process.stdout : undefined,
    terminal: interactive,
  });
  const reader = new LineReader(rl, interactive);
  const ask: AskFn | undefined = interactive
    ? async (summary) => {
        const answer = await reader.next(`${bold('allow')} ${summary}? [y/N] `);
        return ['y', 'yes'].includes((answer ?? '').trim().toLowerCase());
      }
    : undefined;
  session.gate = new PermissionGate(session.gate.mode, session.toolCtx.cwd, ask);

  let currentAbort: AbortController | null = null;
  rl.on('SIGINT', () => {
    if (currentAbort) {
      currentAbort.abort();
    } else {
      write('\n');
      rl.close();
    }
  });

  while (true) {
    const line = await reader.next(PROMPT);
    if (line === undefined) break; // Ctrl+C at prompt, Ctrl+D, or stdin EOF
    const input = line.trim();
    if (!input) continue;
    if (input.startsWith('/')) {
      if (await handleCommand(session, input)) break;
      continue;
    }
    currentAbort = new AbortController();
    try {
      await chatTurn(session, input, currentAbort.signal);
    } catch (err) {
      printError(session, err);
    } finally {
      currentAbort = null;
    }
  }
  rl.close();
}

function toolsLine(session: CliSession): string {
  if (session.protocol === 'none') return 'tools: disabled (--protocol none)';
  const names = session.registry.list(session.gate.mode).map((t) => t.name);
  return `tools: ${names.join(', ')} · protocol: ${session.protocol} · permission mode: ${session.gate.mode}`;
}

function printBanner(session: CliSession): void {
  const p = session.profile;
  console.log(bold('agent-harness v0.1.0'));
  console.log(
    `provider: ${session.providerName} · model: ${session.model} ` +
      dim(`(family ${p.family} · ctx ${session.contextLength} · thinking ${p.thinking})`),
  );
  console.log(dim(toolsLine(session)));
  console.log(dim('/help for commands'));
  console.log();
}

const HELP = `commands:
  /help               show this help
  /models             list models on the current provider
  /model <id>         switch model (re-resolves its profile)
  /provider <name>    switch provider (configured in harness.config.json)
  /session            show where this conversation is being saved
  /clear              reset conversation (keeps system prompt)
  /exit               quit`;

/** Returns true when the REPL should exit. */
async function handleCommand(session: CliSession, input: string): Promise<boolean> {
  const [cmd, ...rest] = input.split(/\s+/);
  const arg = rest.join(' ');
  switch (cmd) {
    case '/exit':
    case '/quit':
      return true;
    case '/help':
      console.log(HELP);
      return false;
    case '/session':
      console.log(session.store ? session.store.file : dim('(session saving is disabled)'));
      return false;
    case '/clear':
      session.messages = session.messages.slice(0, 1);
      session.toolCtx.readFiles.clear();
      console.log(dim('conversation cleared'));
      return false;
    case '/models': {
      try {
        const models = await session.provider.listModels();
        console.log(models.length ? models.join('\n') : dim('(no models)'));
      } catch (err) {
        printError(session, err);
      }
      return false;
    }
    case '/model': {
      if (!arg) {
        console.log(`current model: ${session.model}`);
        return false;
      }
      session.model = arg;
      session.profile = resolveProfile(arg, session.config.models);
      session.contextLength = effectiveContextLength(session.profile, session.config);
      session.think = session.profile.thinking === 'none' ? undefined : true;
      console.log(
        dim(
          `model → ${arg} (family ${session.profile.family} · ctx ${session.contextLength} · thinking ${session.profile.thinking})`,
        ),
      );
      const wantsNative = session.profile.nativeToolCalls;
      if ((session.protocol === 'native') !== wantsNative) {
        console.log(
          dim(
            `note: this model ${wantsNative ? 'supports native tool calls' : 'has no native tool-call support'} but the session protocol is "${session.protocol}" (fixed at startup) — restart to change it`,
          ),
        );
      }
      return false;
    }
    case '/provider': {
      if (!arg) {
        console.log(`current provider: ${session.providerName}`);
        return false;
      }
      const cfg = session.config.providers[arg];
      if (!cfg) {
        console.error(
          `unknown provider "${arg}" — configured: ${Object.keys(session.config.providers).join(', ')}`,
        );
        return false;
      }
      session.provider = createProvider(arg, cfg);
      session.providerName = arg;
      console.log(dim(`provider → ${arg} (${cfg.baseUrl}); switch models with /model if needed`));
      return false;
    }
    default:
      console.error(`unknown command ${cmd} — /help for commands`);
      return false;
  }
}
