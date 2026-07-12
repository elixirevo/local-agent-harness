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
import { sandboxAvailable, sessionSandbox } from '../sandbox/exec.js';
import { rememberNote } from '../session/memory.js';
import { listSessions, loadSession, SessionStore } from '../session/store.js';
import { expandSkill, type Skill } from '../skills/loader.js';
import { bold, dim, green, red, truncateAnsi } from './ansi.js';
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
  /** Workflow files loaded from .harness/skills, invoked as /name. */
  skills: Skill[];
  mcp?: McpConnection[];
  /** One-line startup note (resumed-session info or a resume tip). */
  bannerNote?: string;
}

const PROMPT = '❯ ';

export const COMMANDS: SlashCommand[] = [
  { name: '/help', desc: 'show help' },
  { name: '/models', desc: 'pick a model from the provider' },
  { name: '/model', desc: '<id> — switch model' },
  { name: '/provider', desc: '<name> — switch provider' },
  { name: '/plan', desc: 'toggle plan mode (read-only + plan file)' },
  { name: '/sandbox', desc: 'toggle the Bash sandbox (or: /sandbox on|off)' },
  { name: '/mcp', desc: 'list connected MCP servers' },
  { name: '/remember', desc: '<note> — save to AGENTS.md' },
  { name: '/session', desc: 'show where this session is saved' },
  { name: '/resume', desc: 'pick a saved session to continue' },
  { name: '/context', desc: 'show the context budget' },
  { name: '/compact', desc: 'compact the conversation now' },
  { name: '/clear', desc: 'reset the conversation' },
  { name: '/exit', desc: 'quit' },
];

/** Built-ins plus loaded skills — the list the hint bar and /help show. */
export function allCommands(skills: Skill[]): SlashCommand[] {
  return [...COMMANDS, ...skills.map((s) => ({ name: `/${s.name}`, desc: s.description }))];
}

/**
 * If the input invokes a loaded skill (/name args), return the expanded
 * prompt. Skill names can never collide with built-ins (the loader rejects
 * reserved names), so this can safely run before built-in dispatch.
 */
export function resolveSkillInvocation(
  session: Pick<CliSession, 'skills'>,
  input: string,
): { skill: Skill; prompt: string } | undefined {
  if (!input.startsWith('/')) return undefined;
  const [cmd, ...rest] = input.split(/\s+/);
  const name = cmd.slice(1).toLowerCase();
  const skill = session.skills.find((s) => s.name.toLowerCase() === name);
  if (!skill) return undefined;
  return { skill, prompt: expandSkill(skill, rest.join(' ').trim()) };
}

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
    choose: async () => undefined,
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
    const invocation = resolveSkillInvocation(session, prompt.trim());
    if (invocation) ui.write(dim(`[skill] ${invocation.skill.name}`) + '\n');
    await chatTurn(session, invocation ? invocation.prompt : prompt, ui);
  } finally {
    ui.close();
  }
}

export async function runRepl(session: CliSession): Promise<void> {
  const useRaw = !session.plain && canUseRawTui();
  let ui: ReplUi;
  if (useRaw) {
    ui = new RawTui(allCommands(session.skills));
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
        const invocation = resolveSkillInvocation(session, input);
        if (!invocation) {
          if (await handleCommand(session, input, ui)) break;
          ui.onIdle();
          continue;
        }
        ui.write(dim(`[skill] ${invocation.skill.name}`) + '\n');
        currentAbort = new AbortController();
        try {
          await chatTurn(session, invocation.prompt, ui, currentAbort.signal);
        } catch (err) {
          printError(session, ui, err);
        } finally {
          currentAbort = null;
          ui.onIdle();
        }
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
  const sandbox = session.toolCtx.sandbox ? ' · sandbox: seatbelt' : '';
  return `tools: ${names.join(', ')} · protocol: ${session.protocol} · permission mode: ${session.gate.mode}${sandbox}${plan}`;
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
  if (session.bannerNote) l(dim(session.bannerNote));
  l();
}

function helpText(session: CliSession): string {
  const lines = ['commands:', ...COMMANDS.map((c) => `  ${c.name.padEnd(11)} ${c.desc}`)];
  if (session.skills.length > 0) {
    lines.push('skills (.harness/skills):');
    for (const s of session.skills) lines.push(`  /${s.name.padEnd(10)} ${s.description}`);
  }
  return lines.join('\n');
}

/** Returns true when the REPL should exit. */
/**
 * /resume [id] — swap the running conversation for a saved one. Without an
 * id, offers the saved sessions as a menu (vertical selector in the TUI,
 * numbered list in plain mode).
 */
async function resumeCommand(session: CliSession, ui: ReplUi, arg: string | undefined): Promise<void> {
  const cwd = session.toolCtx.cwd;
  const all = listSessions(cwd).filter((s) => s.file !== session.store?.file);
  if (all.length === 0) {
    ui.write(dim('no saved sessions to resume\n'));
    return;
  }
  let id = arg;
  if (!id) {
    const items = all.map((s) => {
      // Session ids embed local wall-clock time; createdAt is UTC ISO. Prefer
      // the id so the listed time matches what the user's clock showed.
      const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})/.exec(s.id);
      const when = m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}` : s.createdAt.slice(0, 16).replace('T', ' ');
      // Lead with what the session was about — the first typed prompt.
      const preview = s.firstPrompt ? `"${truncateAnsi(s.firstPrompt, 44)}" · ` : '';
      return { name: s.id, desc: `${preview}${s.model} · ${s.messages} msgs · ${when}` };
    });
    const idx = await ui.choose('resume which session?', items);
    if (idx === undefined) {
      ui.write(dim('cancelled\n'));
      return;
    }
    id = all[idx].id;
  }
  let loaded: ReturnType<typeof loadSession>;
  try {
    loaded = loadSession(cwd, id);
  } catch (err) {
    ui.write(red((err as Error).message) + '\n');
    return;
  }
  if (loaded.messages[0]?.role !== 'system' && session.messages[0]?.role === 'system') {
    loaded.messages.unshift(session.messages[0]);
  }
  session.messages = loaded.messages;
  if (session.store) {
    // Adopt the resumed transcript; future turns append to its file.
    const store = new SessionStore(loaded.meta);
    store.markSaved(loaded.messages.length);
    session.store = store;
  }
  session.transcriptPath = loaded.file;
  session.toolCtx.readFiles = new Map();
  session.reminders.enqueue(
    'This session was resumed from an earlier saved conversation. The filesystem may have changed since — Read files again before editing them.',
  );
  const turns = loaded.messages.filter((m) => m.role !== 'system').length;
  ui.write(dim(`resumed ${loaded.meta.id} (${turns} messages)\n`));
  if (loaded.meta.model !== session.model) {
    ui.write(dim(`note: recorded with ${loaded.meta.model}; you are on ${session.model} (switch with /model)\n`));
  }
}

/** Switch the session to a model: profile, context length, thinking. */
function applyModel(session: CliSession, id: string, l: (s?: string) => void): void {
  session.model = id;
  session.profile = resolveProfile(id, session.config.models);
  session.contextLength = effectiveContextLength(session.profile, session.config);
  session.think = session.profile.thinking === 'none' ? undefined : true;
  l(
    dim(
      `model → ${id} (family ${session.profile.family} · ctx ${session.contextLength} · thinking ${session.profile.thinking})`,
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
}

async function handleCommand(session: CliSession, input: string, ui: ReplUi): Promise<boolean> {
  const [cmd, ...rest] = input.split(/\s+/);
  const arg = rest.join(' ');
  const l = (s = '') => ui.write(s + '\n');
  switch (cmd) {
    case '/exit':
    case '/quit':
      return true;
    case '/help':
      l(helpText(session));
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
    case '/sandbox': {
      const current = session.toolCtx.sandbox !== undefined;
      let target: boolean;
      if (arg === 'on') target = true;
      else if (arg === 'off') target = false;
      else if (arg) {
        l(red(`unknown argument "${arg}" — use /sandbox, /sandbox on, or /sandbox off`));
        return false;
      } else target = !current;
      if (target === current) {
        l(dim(`sandbox already ${current ? 'on' : 'off'}`));
        return false;
      }
      if (target) {
        if (!sandboxAvailable()) {
          l(red('sandbox unavailable on this platform (needs macOS sandbox-exec)'));
          return false;
        }
        session.config.sandbox.bash = 'on';
        session.toolCtx.sandbox = sessionSandbox(session.toolCtx.cwd, session.config.sandbox);
        l(dim('sandbox ON — Bash writes limited to cwd+tmp, network blocked; sandboxed mutations run without asking'));
      } else {
        session.config.sandbox.bash = 'off';
        session.toolCtx.sandbox = undefined;
        l(dim('sandbox OFF — Bash runs unrestricted; mutations ask for approval again'));
      }
      return false;
    }
    case '/mcp': {
      if (!session.mcp || session.mcp.length === 0) {
        l(dim('(no MCP servers configured — add mcpServers or "webFetch": "mcp" to harness.config.json)'));
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
    case '/resume':
      await resumeCommand(session, ui, arg || undefined);
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
        if (models.length === 0) {
          l(dim('(no models)'));
          return false;
        }
        const items = models.map((m) => {
          const p = resolveProfile(m, session.config.models);
          const ctx = effectiveContextLength(p, session.config);
          const current = m === session.model ? ' · current' : '';
          return {
            name: m,
            desc: `${p.family} · ctx ${ctx} · ${p.nativeToolCalls ? 'native tools' : 'text protocol'}${current}`,
          };
        });
        const idx = await ui.choose('switch to which model?', items);
        if (idx === undefined) {
          l(dim('cancelled'));
          return false;
        }
        if (models[idx] === session.model) {
          l(dim(`already on ${session.model}`));
          return false;
        }
        applyModel(session, models[idx], l);
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
      applyModel(session, arg, l);
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
