#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createAgentTool } from '../agents/agentTool.js';
import { ReminderQueue } from '../context/reminders.js';
import { startupContext } from '../context/startup.js';
import { effectiveContextLength, loadConfig } from '../config/config.js';
import { resolveProfile, type PromptTier } from '../models/profile.js';
import { closeMcpConnections, connectMcpServers, type McpConnection } from '../mcp/index.js';
import { PermissionGate, PERMISSION_MODES, type PermissionMode } from '../permissions/gate.js';
import { buildSystemPrompt, type ToolProtocol } from '../prompts/assemble.js';
import { planFilePath, planModeEnterReminder } from '../prompts/planMode.js';
import { createProvider } from '../providers/index.js';
import type { ChatMessage } from '../providers/types.js';
import { loadSession, newSessionId, SessionStore } from '../session/store.js';
import { defaultRegistry } from '../tools/registry.js';
import { friendlyFetchError, oneShot, runRepl, type CliSession } from './repl.js';

const VERSION = '0.1.0';

const USAGE = `agent-harness ${VERSION} — local LLM agent harness (Ollama / llama.cpp / vLLM)

Usage:
  harness [options]              start interactive REPL
  harness -p "task"              one-shot mode (prints the run and exits)

Options:
  -P, --provider <name>        provider name from config (default: ollama)
  -m, --model <id>             model id (default: config.defaultModel, else first available)
  -p, --prompt <text>          one-shot prompt
  -M, --permission-mode <m>    readonly | ask | auto (default: ask)
                               readonly: mutating tools are not offered to the model
                               ask: mutations ask y/N (Bash read-only commands run freely)
                               auto: mutations in the working dir run without asking;
                               destructive commands always ask
      --plan                   start in plan mode: read-only exploration, mutations
                               allowed only in .harness/plan.md (toggle with /plan)
      --protocol <p>           native | text | none — force the tool protocol
                               (default: native if the model profile supports it, else text)
      --tier <t>               minimal | standard | full — system prompt tier
                               (default: from the model profile)
      --resume <id|last>       resume a saved session from .harness/sessions/
      --no-save                do not persist this session
      --base-url <url>         override the provider's base URL
      --ctx <n>                context length (overrides the profile/config cap)
      --system <text>          override the system prompt
      --no-think               disable thinking on models that support toggling it
  -h, --help                   show help
  -v, --version                show version

Config: ./harness.config.json (optional; defaults target localhost servers)`;

async function main(): Promise<void> {
  if (process.argv[2] === 'eval') {
    const { evalMain } = await import('../eval/main.js');
    await evalMain(process.argv.slice(3));
    return;
  }
  const { values } = parseArgs({
    options: {
      provider: { type: 'string', short: 'P' },
      model: { type: 'string', short: 'm' },
      prompt: { type: 'string', short: 'p' },
      'permission-mode': { type: 'string', short: 'M' },
      plan: { type: 'boolean' },
      protocol: { type: 'string' },
      tier: { type: 'string' },
      resume: { type: 'string' },
      'no-save': { type: 'boolean' },
      'base-url': { type: 'string' },
      ctx: { type: 'string' },
      system: { type: 'string' },
      'no-think': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
    },
  });

  if (values.help) {
    console.log(USAGE);
    return;
  }
  if (values.version) {
    console.log(VERSION);
    return;
  }

  const cwd = process.cwd();
  const config = loadConfig(cwd);
  const providerName = values.provider ?? config.defaultProvider;
  const providerCfg = config.providers[providerName];
  if (!providerCfg) {
    die(`unknown provider "${providerName}" — configured: ${Object.keys(config.providers).join(', ')}`);
  }
  if (values['base-url']) providerCfg.baseUrl = values['base-url'];
  const provider = createProvider(providerName, providerCfg);

  const mode = (values['permission-mode'] ?? config.permissionMode) as PermissionMode;
  if (!PERMISSION_MODES.includes(mode)) {
    die(`invalid --permission-mode "${mode}" — use one of: ${PERMISSION_MODES.join(', ')}`);
  }

  const resumed = values.resume !== undefined ? tryLoad(cwd, values.resume) : undefined;

  let model = values.model ?? resumed?.meta.model ?? config.defaultModel;
  if (!model) {
    let models: string[];
    try {
      models = await provider.listModels();
    } catch (err) {
      die(friendlyFetchError(providerName, providerCfg.baseUrl, err));
    }
    if (models.length === 0) {
      die(
        `no models available on ${providerName}${providerName === 'ollama' ? ' — pull one with: ollama pull <model>' : ''}`,
      );
    }
    model = models[0];
  }

  const profile = resolveProfile(model, config.models);

  let tier = profile.promptTier;
  if (values.tier !== undefined) {
    if (!['minimal', 'standard', 'full'].includes(values.tier)) {
      die(`invalid --tier "${values.tier}" — use minimal | standard | full`);
    }
    tier = values.tier as PromptTier;
  }

  let protocol: ToolProtocol = profile.nativeToolCalls ? 'native' : 'text';
  if (values.protocol !== undefined) {
    if (!['native', 'text', 'none'].includes(values.protocol)) {
      die(`invalid --protocol "${values.protocol}" — use native | text | none`);
    }
    protocol = values.protocol as ToolProtocol;
  }

  let contextLength = effectiveContextLength(profile, config);
  if (values.ctx !== undefined) {
    const n = Number.parseInt(values.ctx, 10);
    if (!Number.isFinite(n) || n <= 0) die(`invalid --ctx value: ${values.ctx}`);
    contextLength = n;
  }

  const registry = defaultRegistry();
  const reminders = new ReminderQueue();

  // Every tool must be registered BEFORE the system prompt is built — the
  // text-protocol section embeds the tool list at build time.
  // The subagent getter reads the live session so /model switches apply.
  registry.register(
    createAgentTool(() => ({
      provider: session.provider,
      config: session.config,
      cwd,
      parentModel: session.model,
    })),
  );
  let mcp: McpConnection[] = [];
  if (config.mcpServers && Object.keys(config.mcpServers).length > 0) {
    mcp = await connectMcpServers(config.mcpServers, registry);
    for (const c of mcp) {
      if (c.error) console.error(`warning: MCP server "${c.client.name}": ${c.error}`);
    }
  }

  let messages: ChatMessage[];
  if (resumed) {
    messages = resumed.messages;
    if (messages[0]?.role !== 'system') {
      messages.unshift({
        role: 'system',
        content: buildSystemPrompt({ tier, protocol, mode, registry, cwd }),
      });
    }
    reminders.enqueue(
      'This session was resumed from an earlier saved conversation. The filesystem may have changed since — Read files again before editing them.',
    );
  } else {
    const systemPrompt =
      values.system ?? config.systemPrompt ?? buildSystemPrompt({ tier, protocol, mode, registry, cwd });
    messages = [{ role: 'system', content: systemPrompt }];
    reminders.enqueue(startupContext(cwd));
  }

  const save = config.saveSessions && !values['no-save'];
  let store: SessionStore | undefined;
  if (save) {
    if (resumed) {
      store = new SessionStore(resumed.meta);
      store.markSaved(resumed.messages.length);
    } else {
      store = new SessionStore({
        id: newSessionId(),
        createdAt: new Date().toISOString(),
        provider: providerName,
        model,
        cwd,
      });
    }
  }

  const planMode = values.plan === true;
  const planFile = planFilePath(cwd);
  if (planMode) reminders.enqueue(planModeEnterReminder(planFile));

  const session: CliSession = {
    provider,
    providerName,
    model,
    profile,
    config,
    contextLength,
    think: profile.thinking === 'none' ? undefined : !values['no-think'],
    messages,
    registry,
    // The REPL swaps in a gate wired to its readline for interactive approval.
    gate: planMode
      ? new PermissionGate('plan', cwd, undefined, planFile)
      : new PermissionGate(mode, cwd, undefined),
    toolCtx: { cwd, readFiles: new Map() },
    maxSteps: config.maxSteps,
    protocol,
    reminders,
    store,
    compaction: config.compaction,
    transcriptPath: store?.file,
    onCompacted: (compacted) => store?.recordCompaction(compacted),
    baseMode: mode,
    planMode,
    mcp,
  };

  try {
    if (values.prompt !== undefined) {
      try {
        await oneShot(session, values.prompt);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          msg.includes('fetch failed') ? friendlyFetchError(providerName, providerCfg.baseUrl, err) : msg,
        );
        process.exitCode = 1;
      }
    } else {
      await runRepl(session);
    }
  } finally {
    closeMcpConnections(mcp);
  }
}

function tryLoad(cwd: string, idOrLast: string): ReturnType<typeof loadSession> {
  try {
    return loadSession(cwd, idOrLast);
  } catch (e) {
    die((e as Error).message);
  }
}

function die(message: string): never {
  console.error(message);
  process.exit(1);
}

main().catch((err) => {
  die(err instanceof Error ? err.message : String(err));
});
