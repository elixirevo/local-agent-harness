import * as readline from 'node:readline';
import { effectiveContextLength, type HarnessConfig } from '../config/config.js';
import { resolveProfile, type ResolvedProfile } from '../models/profile.js';
import { createProvider } from '../providers/index.js';
import type {
  ChatMessage,
  ProviderAdapter,
  StopReason,
  ToolCall,
  Usage,
} from '../providers/types.js';

export interface Session {
  provider: ProviderAdapter;
  providerName: string;
  model: string;
  profile: ResolvedProfile;
  config: HarnessConfig;
  /** Effective context window sent to the provider. */
  contextLength: number;
  /** undefined = model has no toggleable thinking. */
  think: boolean | undefined;
  /** Append-only conversation history; [0] is the system prompt. */
  messages: ChatMessage[];
}

export interface GenResult {
  content: string;
  thinking: string;
  toolCalls: ToolCall[];
  usage?: Usage;
  stopReason: StopReason;
  wallMs: number;
}

interface GenOutput {
  onText?: (t: string) => void;
  onThinking?: (t: string) => void;
}

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const dim = (s: string) => (useColor ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s: string) => (useColor ? `\x1b[1m${s}\x1b[0m` : s);

/** Run one model call over the session history, streaming through `out`. */
export async function generate(
  session: Session,
  out: GenOutput = {},
  signal?: AbortSignal,
): Promise<GenResult> {
  const started = Date.now();
  let content = '';
  let thinking = '';
  const toolCalls: ToolCall[] = [];
  let usage: Usage | undefined;
  let stopReason: StopReason = 'unknown';

  try {
    for await (const chunk of session.provider.chat({
      model: session.model,
      messages: session.messages,
      temperature: session.profile.temperature,
      contextLength: session.contextLength,
      thinking: session.profile.thinking,
      think: session.think,
      signal,
    })) {
      switch (chunk.type) {
        case 'text':
          content += chunk.text;
          out.onText?.(chunk.text);
          break;
        case 'thinking':
          thinking += chunk.text;
          out.onThinking?.(chunk.text);
          break;
        case 'tool_call':
          toolCalls.push(chunk.call);
          break;
        case 'usage':
          usage = chunk.usage;
          break;
        case 'done':
          stopReason = chunk.stopReason;
          break;
      }
    }
  } catch (err) {
    if (isAbortError(err)) {
      stopReason = 'aborted';
    } else {
      throw err;
    }
  }
  return { content, thinking, toolCalls, usage, stopReason, wallMs: Date.now() - started };
}

function isAbortError(err: unknown): boolean {
  const e = err as { name?: string; code?: string };
  return e?.name === 'AbortError' || e?.code === 'ABORT_ERR';
}

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
  const prefill = u.promptMs !== undefined ? ` in ${u.promptMs < 100 ? u.promptMs.toFixed(0) : Math.round(u.promptMs)}ms` : '';
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

/** One user turn: stream the answer to stdout and record it in history. */
async function chatTurn(session: Session, input: string, signal?: AbortSignal): Promise<void> {
  session.messages.push({ role: 'user', content: input });
  let sawThinking = false;
  let startedText = false;
  try {
    const res = await generate(
      session,
      {
        onThinking: (t) => {
          if (!sawThinking) {
            process.stdout.write(dim('[thinking] '));
            sawThinking = true;
          }
          process.stdout.write(dim(t));
        },
        onText: (t) => {
          if (sawThinking && !startedText) process.stdout.write('\n\n');
          startedText = true;
          process.stdout.write(t);
        },
      },
      signal,
    );
    process.stdout.write('\n');
    if (res.stopReason === 'aborted') {
      console.log(dim('[interrupted]'));
      if (!res.content) {
        session.messages.pop(); // turn never produced anything — drop it
        return;
      }
    }
    if (res.stopReason === 'length') console.log(dim('[hit max output length]'));
    // History stores only the answer, never the reasoning: thinking must not
    // be replayed into the next prompt (context cost, and models don't expect it).
    session.messages.push({ role: 'assistant', content: res.content });
    if (res.usage) console.log(dim(formatUsage(res.usage, res.wallMs)));
  } catch (err) {
    session.messages.pop(); // keep history consistent on failure
    throw err;
  }
}

export async function oneShot(session: Session, prompt: string): Promise<void> {
  await chatTurn(session, prompt);
}

const HELP = `commands:
  /help               show this help
  /models             list models on the current provider
  /model <id>         switch model (re-resolves its profile)
  /provider <name>    switch provider (${'{'}configured in harness.config.json${'}'})
  /clear              reset conversation (keeps system prompt)
  /exit               quit`;

export async function runRepl(session: Session): Promise<void> {
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (interactive) printBanner(session);

  const rl = readline.createInterface({
    input: process.stdin,
    output: interactive ? process.stdout : undefined,
    terminal: interactive,
    prompt: useColor ? '\x1b[36m❯\x1b[0m ' : '> ',
  });

  let currentAbort: AbortController | null = null;
  rl.on('SIGINT', () => {
    if (currentAbort) {
      currentAbort.abort();
    } else {
      process.stdout.write('\n');
      rl.close();
    }
  });

  if (interactive) rl.prompt();
  for await (const raw of rl) {
    const input = raw.trim();
    if (input) {
      if (input.startsWith('/')) {
        const quit = await handleCommand(session, input);
        if (quit) break;
      } else {
        currentAbort = new AbortController();
        try {
          await chatTurn(session, input, currentAbort.signal);
        } catch (err) {
          printError(session, err);
        } finally {
          currentAbort = null;
        }
      }
    }
    if (interactive) rl.prompt();
  }
  rl.close();
}

function printBanner(session: Session): void {
  const p = session.profile;
  console.log(bold(`agent-harness v0.1.0`));
  console.log(
    `provider: ${session.providerName} · model: ${session.model} ` +
      dim(`(family ${p.family} · ctx ${session.contextLength} · thinking ${p.thinking})`),
  );
  console.log(dim('/help for commands'));
  console.log(
    dim(
      'tip: watch the prompt prefill time in the stats line — a warm prefix cache makes it collapse on follow-up turns (llama.cpp/vLLM additionally report evaluated vs cached token counts).',
    ),
  );
  console.log();
}

function printError(session: Session, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('fetch failed')) {
    const cfg = session.config.providers[session.providerName];
    console.error(friendlyFetchError(session.providerName, cfg?.baseUrl ?? '?', err));
  } else {
    console.error(msg);
  }
}

/** Returns true when the REPL should exit. */
async function handleCommand(session: Session, input: string): Promise<boolean> {
  const [cmd, ...rest] = input.split(/\s+/);
  const arg = rest.join(' ');
  switch (cmd) {
    case '/exit':
    case '/quit':
      return true;
    case '/help':
      console.log(HELP);
      return false;
    case '/clear': {
      session.messages = session.messages.slice(0, 1);
      console.log(dim('conversation cleared'));
      return false;
    }
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
