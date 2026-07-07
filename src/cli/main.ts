#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { effectiveContextLength, loadConfig } from '../config/config.js';
import { resolveProfile } from '../models/profile.js';
import { createProvider } from '../providers/index.js';
import { friendlyFetchError, oneShot, runRepl, type Session } from './repl.js';

const VERSION = '0.1.0';

const USAGE = `agent-harness ${VERSION} — local LLM agent harness (Ollama / llama.cpp / vLLM)

Usage:
  harness [options]              start interactive REPL
  harness -p "question"          one-shot mode (prints answer and exits)

Options:
  -P, --provider <name>   provider name from config (default: ollama)
  -m, --model <id>        model id (default: config.defaultModel, else first available)
  -p, --prompt <text>     one-shot prompt
      --base-url <url>    override the provider's base URL
      --ctx <n>           context length (overrides the profile/config cap)
      --system <text>     override the system prompt
      --no-think          disable thinking on models that support toggling it
  -h, --help              show help
  -v, --version           show version

Config: ./harness.config.json (optional; defaults target localhost servers)`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      provider: { type: 'string', short: 'P' },
      model: { type: 'string', short: 'm' },
      prompt: { type: 'string', short: 'p' },
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

  const config = loadConfig();
  const providerName = values.provider ?? config.defaultProvider;
  const providerCfg = config.providers[providerName];
  if (!providerCfg) {
    die(`unknown provider "${providerName}" — configured: ${Object.keys(config.providers).join(', ')}`);
  }
  if (values['base-url']) providerCfg.baseUrl = values['base-url'];
  const provider = createProvider(providerName, providerCfg);

  let model = values.model ?? config.defaultModel;
  if (!model) {
    let models: string[];
    try {
      models = await provider.listModels();
    } catch (err) {
      die(friendlyFetchError(providerName, providerCfg.baseUrl, err));
    }
    if (models.length === 0) {
      die(`no models available on ${providerName}${providerName === 'ollama' ? ' — pull one with: ollama pull <model>' : ''}`);
    }
    model = models[0];
  }

  const profile = resolveProfile(model, config.models);
  let contextLength = effectiveContextLength(profile, config);
  if (values.ctx !== undefined) {
    const n = Number.parseInt(values.ctx, 10);
    if (!Number.isFinite(n) || n <= 0) die(`invalid --ctx value: ${values.ctx}`);
    contextLength = n;
  }
  if (values.system) config.systemPrompt = values.system;

  const session: Session = {
    provider,
    providerName,
    model,
    profile,
    config,
    contextLength,
    think: profile.thinking === 'none' ? undefined : !values['no-think'],
    messages: [{ role: 'system', content: config.systemPrompt }],
  };

  if (values.prompt !== undefined) {
    try {
      await oneShot(session, values.prompt);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      die(msg.includes('fetch failed') ? friendlyFetchError(providerName, providerCfg.baseUrl, err) : msg);
    }
  } else {
    await runRepl(session);
  }
}

function die(message: string): never {
  console.error(message);
  process.exit(1);
}

main().catch((err) => {
  die(err instanceof Error ? err.message : String(err));
});
