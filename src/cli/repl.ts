import * as readline from 'node:readline/promises';
import { compactSession } from '../compact/compact.js';
import { budgetStatus } from '../context/budget.js';
import { effectiveContextLength, type HarnessConfig } from '../config/config.js';
import { runTurn, type AgentEvent, type AgentSession } from '../core/loop.js';
import type { McpConnection } from '../mcp/index.js';
import { resolveProfile } from '../models/profile.js';
import { PermissionGate, type AskFn, type PermissionMode } from '../permissions/gate.js';
import { planFilePath, planModeEnterReminder, planModeExitReminder } from '../prompts/planMode.js';
import { createProvider } from '../providers/index.js';
import type { Usage } from '../providers/types.js';
import { rememberNote } from '../session/memory.js';
import type { SessionStore } from '../session/store.js';
import { bold, dim, green, red } from './ansi.js';
import type { SlashCommand } from './editor.js';
import { canUseRawTui, RawTui } from './tui.js';
import { PlainUi, Spinner, type ReplUi } from './ui.js';

export interface CliSession extends AgentSession {
  providerName: string;
  config: HarnessConfig;
  store?: SessionStore;
  /** The permission mode outside plan mode (plan swaps the gate temporarily). */
  baseMode: PermissionMode;
  planMode: boolean;
  /** Force the line-by-line UI even on a TTY (--plain). */
  plain: boolean;
  /** Interactive approval hook, kept so plan-mode toggles can rebuild the gate. */
  askFn?: AskFn;
  /** Tool names the user approved with "always" this session (shared with the gate). */
  sessionAllow: Set<string>;
  mcp?: McpConnection[];
}

const PROMPT = '❯ ';

export const COMMANDS: SlashCommand[] = [
  { name: '/help', desc: 'show help' },
  { name: '/models', desc: 'list models on the provider' },
  { name: '/model', desc: '<id> — switch model' },
  { name: '/provider', desc: '<name> — switch provider' },
  { name: '/plan', desc: 'toggle plan mode (read-only + plan file)' },
  { name: '/mcp', desc: 'list connected MCP servers' },
  { name: '/remember', desc: '<note> — save to AGENTS.md' },
  { name: '/session', desc: 'show where this session is saved' },
  { name: '/context', desc: 'show the context budget' },
  { name: '/compact', desc: 'compact the conversation now' },
  { name: '/clear', desc: 'reset the conversation' },
  { name: '/exit', desc: 'quit' },
];

export function friendlyFetchError(providerName: string, baseUrl: string, err: unknown): string {
  const cause = (err as { cause?: { code?: string } })?.cause;
  const code = cause?.code ? ` (${cause.code})` : '';
  const hints: Record<string, string> = {
    ollama: 'Start it with: ollama serve',
    llamacpp: 'Start it with: llama-server --jinja -m <model.gguf>',
    vllm: 'Start it with: vllm serve <model>',
    mlx: 'Start it with: mlx_lm.server --model <mlx-model> --port 8081',
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

function ensureNewline(st: RenderState, ui: ReplUi): void {
  if (!st.atLineStart) {
    ui.write('\n');
    st.atLineStart = true;
  }
}

function renderEvent(ev: AgentEvent, st: RenderState, ui: ReplUi): void {
  switch (ev.type) {
    case 'thinking':
      if (!st.sawThinking) {
        ensureNewline(st, ui);
        ui.write(dim('[thinking] '));
        st.sawThinking = true;
      }
      ui.write(dim(ev.text));
      st.atLineStart = ev.text.endsWith('\n');
      break;
    case 'text':
      if (st.sawThinking && !st.startedText) {
        ui.write('\n\n');
        st.atLineStart = true;
      }
      st.startedText = true;
      ui.write(ev.text);
      st.atLineStart = ev.text.endsWith('\n');
      break;
    case 'tool_start':
      ensureNewline(st, ui);
      ui.write(dim(`→ ${ev.name} ${ev.summary}`) + '\n');
      break;
    case 'tool_end':
      ui.write(`  ${ev.ok ? green('✓') : red('✗')} ${dim(ev.summary)}` + '\n');
      break;
    case 'step': {
      ensureNewline(st, ui);
      if (ev.usage) {
        const ctx = ev.contextPct !== undefined ? ` · ctx ~${ev.contextPct}%` : '';
        ui.write(dim(formatUsage(ev.usage, ev.wallMs).replace(/]$/, `${ctx}]`)) + '\n');
      }
      st.sawThinking = false;
      st.startedText = false;
      break;
    }
    case 'notice':
      ensureNewline(st, ui);
      ui.write(dim(`[note] ${ev.message}`) + '\n');
      break;
    case 'guard':
      ensureNewline(st, ui);
      ui.write(dim(`[guard] ${ev.message}`) + '\n');
      break;
  }
}

/**
 * One user turn through the agent loop. On any failure the whole turn is
 * rolled back (messages reset to the pre-turn snapshot) so history never
 * carries an assistant message with dangling tool calls. The iterator is
 * driven manually so the UI can show a "working" indicator during each wait.
 */
async function chatTurn(session: CliSession, input: string, ui: ReplUi, signal?: AbortSignal): Promise<void> {
  const snapshot = session.messages.slice();
  const st = newRenderState();
  try {
    const it = runTurn(session, input, signal)[Symbol.asyncIterator]();
    while (true) {
      ui.beginWait(st.atLineStart);
      const { value, done } = await it.next();
      ui.endWait();
      if (done) break;
      renderEvent(value, st, ui);
    }
    ensureNewline(st, ui);
    session.store?.append(session.messages);
  } catch (err) {
    ui.endWait();
    session.messages = snapshot;
    ensureNewline(st, ui);
    if (isAbortError(err)) {
      ui.write(dim('[interrupted — turn discarded]') + '\n');
      return;
    }
    throw err;
  }
}

function isAbortError(err: unknown): boolean {
  const e = err as { name?: string; code?: string };
  return e?.name === 'AbortError' || e?.code === 'ABORT_ERR';
}

function printError(session: CliSession, ui: ReplUi, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('fetch failed')) {
    const cfg = session.config.providers[session.providerName];
    ui.write(red(friendlyFetchError(session.providerName, cfg?.baseUrl ?? '?', err)) + '\n');
  } else {
    ui.write(red(msg) + '\n');
  }
}

/** A write-only UI for one-shot mode (no input; spinner inert on non-TTY). */
function writeOnlyUi(): ReplUi {
  const spinner = new Spinner();
  return {
    interactive: false,
    write: (s) => void process.stdout.write(s),
    readLine: async () => undefined,
    ask: async () => 'deny',
    beginWait: (c) => spinner.arm(c),
    endWait: () => spinner.disarm(),
    onIdle: () => {},
    onInterrupt: () => {},
    close: () => spinner.disarm(),
  };
}

export async function oneShot(session: CliSession, prompt: string): Promise<void> {
  // Non-interactive: "ask" cannot prompt, so mutations are denied with a hint.
  if (!session.planMode) {
    session.gate = new PermissionGate(session.baseMode, session.toolCtx.cwd, undefined, undefined, session.sessionAllow);
  }
  const ui = writeOnlyUi();
  try {
    await chatTurn(session, prompt, ui);
  } finally {
    ui.close();
  }
}

export async function runRepl(session: CliSession): Promise<void> {
  const useRaw = !session.plain && canUseRawTui();
  let ui: ReplUi;
  if (useRaw) {
    ui = new RawTui(COMMANDS);
  } else {
    const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
    const rl = readline.createInterface({
      input: process.stdin,
      output: interactive ? process.stdout : undefined,
      terminal: interactive,
    });
    ui = new PlainUi(rl, interactive);
  }

  session.askFn = ui.interactive ? (summary, allowAlways) => ui.ask(summary, allowAlways) : undefined;
  if (!session.planMode) {
    session.gate = new PermissionGate(
      session.baseMode,
      session.toolCtx.cwd,
      session.askFn,
      undefined,
      session.sessionAllow,
    );
  }

  printBanner(session, ui);

  let currentAbort: AbortController | null = null;
  ui.onInterrupt(() => {
    if (currentAbort) currentAbort.abort();
    else ui.close();
  });

  try {
    while (true) {
      const lineIn = await ui.readLine(PROMPT);
      if (lineIn === undefined) break;
      const input = lineIn.trim();
      if (!input) {
        ui.onIdle();
        continue;
      }
      if (input.startsWith('/')) {
        if (await handleCommand(session, input, ui)) break;
        ui.onIdle();
        continue;
      }
      currentAbort = new AbortController();
      try {
        await chatTurn(session, input, ui, currentAbort.signal);
      } catch (err) {
        printError(session, ui, err);
      } finally {
        currentAbort = null;
        ui.onIdle();
      }
    }
  } finally {
    ui.close();
  }
}

function toolsLine(session: CliSession): string {
  if (session.protocol === 'none') return 'tools: disabled (--protocol none)';
  const names = session.registry.list(session.gate.mode).map((t) => t.name);
  const plan = session.planMode ? ' · PLAN MODE' : '';
  return `tools: ${names.join(', ')} · protocol: ${session.protocol} · permission mode: ${session.gate.mode}${plan}`;
}

function printBanner(session: CliSession, ui: ReplUi): void {
  const l = (s = '') => ui.write(s + '\n');
  const p = session.profile;
  l(bold('agent-harness v0.1.0'));
  l(
    `provider: ${session.providerName} · model: ${session.model} ` +
      dim(`(family ${p.family} · ctx ${session.contextLength} · thinking ${p.thinking})`),
  );
  l(dim(toolsLine(session)));
  l(dim('/help for commands'));
  l();
}

function helpText(): string {
  return ['commands:', ...COMMANDS.map((c) => `  ${c.name.padEnd(11)} ${c.desc}`)].join('\n');
}

/** Returns true when the REPL should exit. */
async function handleCommand(session: CliSession, input: string, ui: ReplUi): Promise<boolean> {
  const [cmd, ...rest] = input.split(/\s+/);
  const arg = rest.join(' ');
  const l = (s = '') => ui.write(s + '\n');
  switch (cmd) {
    case '/exit':
    case '/quit':
      return true;
    case '/help':
      l(helpText());
      return false;
    case '/plan': {
      const planFile = planFilePath(session.toolCtx.cwd);
      session.planMode = !session.planMode;
      if (session.planMode) {
        session.gate = new PermissionGate('plan', session.toolCtx.cwd, undefined, planFile, session.sessionAllow);
        session.reminders.enqueue(planModeEnterReminder(planFile));
        l(dim(`plan mode ON — mutations restricted to ${planFile}`));
      } else {
        session.gate = new PermissionGate(
          session.baseMode,
          session.toolCtx.cwd,
          session.askFn,
          undefined,
          session.sessionAllow,
        );
        session.reminders.enqueue(planModeExitReminder(planFile));
        l(dim(`plan mode OFF (permission mode: ${session.baseMode})`));
      }
      return false;
    }
    case '/mcp': {
      if (!session.mcp || session.mcp.length === 0) {
        l(dim('(no MCP servers configured — add mcpServers to harness.config.json)'));
        return false;
      }
      for (const c of session.mcp) {
        if (c.error) l(`${c.client.name}: ${dim(`connection failed — ${c.error}`)}`);
        else
          l(
            `${c.client.name} (${c.client.serverInfo?.name ?? '?'}): ${c.toolNames.length ? c.toolNames.join(', ') : dim('(no tools)')}`,
          );
      }
      return false;
    }
    case '/remember': {
      if (!arg) {
        l(dim('usage: /remember <note to save to AGENTS.md>'));
        return false;
      }
      try {
        const { file, created } = rememberNote(session.toolCtx.cwd, arg);
        l(dim(`${created ? 'created' : 'updated'} ${file}`));
      } catch (err) {
        printError(session, ui, err);
      }
      return false;
    }
    case '/session':
      l(session.store ? session.store.file : dim('(session saving is disabled)'));
      return false;
    case '/context': {
      const defs =
        session.protocol === 'native'
          ? session.registry.toolDefs(session.gate.mode, session.profile.promptTier)
          : [];
      const s = budgetStatus(session.messages, session.contextLength, session.compaction, defs);
      l(
        `~${s.estimatedTokens} of ${s.usableTokens} usable tokens (${Math.round(s.usage * 100)}%) · ` +
          `${session.messages.length} messages · window ${session.contextLength} (reserve ${session.compaction.reserveTokens})`,
      );
      return false;
    }
    case '/compact': {
      try {
        const result = await compactSession(session.messages, {
          provider: session.provider,
          model: session.model,
          contextLength: session.contextLength,
          thinking: session.profile.thinking,
          think: session.think,
          transcriptPath: session.store?.file,
        });
        session.messages = result.messages;
        session.toolCtx.readFiles.clear();
        session.store?.recordCompaction(result.messages);
        l(
          dim(
            `compacted ~${result.beforeTokens} → ~${result.afterTokens} tok${result.degraded ? ' (summary failed validation)' : ''}`,
          ),
        );
      } catch (err) {
        printError(session, ui, err);
      }
      return false;
    }
    case '/clear':
      session.messages = session.messages.slice(0, 1);
      session.toolCtx.readFiles.clear();
      l(dim('conversation cleared'));
      return false;
    case '/models': {
      try {
        const models = await session.provider.listModels();
        l(models.length ? models.join('\n') : dim('(no models)'));
      } catch (err) {
        printError(session, ui, err);
      }
      return false;
    }
    case '/model': {
      if (!arg) {
        l(`current model: ${session.model}`);
        return false;
      }
      session.model = arg;
      session.profile = resolveProfile(arg, session.config.models);
      session.contextLength = effectiveContextLength(session.profile, session.config);
      session.think = session.profile.thinking === 'none' ? undefined : true;
      l(
        dim(
          `model → ${arg} (family ${session.profile.family} · ctx ${session.contextLength} · thinking ${session.profile.thinking})`,
        ),
      );
      const wantsNative = session.profile.nativeToolCalls;
      if ((session.protocol === 'native') !== wantsNative) {
        l(
          dim(
            `note: this model ${wantsNative ? 'supports native tool calls' : 'has no native tool-call support'} but the session protocol is "${session.protocol}" (fixed at startup) — restart to change it`,
          ),
        );
      }
      return false;
    }
    case '/provider': {
      if (!arg) {
        l(`current provider: ${session.providerName}`);
        return false;
      }
      const cfg = session.config.providers[arg];
      if (!cfg) {
        l(red(`unknown provider "${arg}" — configured: ${Object.keys(session.config.providers).join(', ')}`));
        return false;
      }
      session.provider = createProvider(arg, cfg);
      session.providerName = arg;
      l(dim(`provider → ${arg} (${cfg.baseUrl}); switch models with /model if needed`));
      return false;
    }
    default:
      l(red(`unknown command ${cmd} — /help for commands`));
      return false;
  }
}
