import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_COMPACTION, type CompactionSettings } from '../context/budget.js';
import type { ModelProfile, ResolvedProfile } from '../models/profile.js';
import type { PermissionMode } from '../permissions/gate.js';

export interface ProviderConfig {
  type: 'ollama' | 'llamacpp' | 'vllm' | 'mlx' | 'openai-compat';
  baseUrl: string;
  apiKey?: string;
  keepAlive?: string;
}

/**
 * How the model reaches the web:
 * - 'off'    — no web access (default)
 * - 'native' — built-in WebFetch tool (GET only, public hosts, HTML→text)
 * - 'mcp'    — an MCP fetch server; a default (uvx mcp-server-fetch) is
 *              injected unless mcpServers already defines "fetch"
 */
export type WebFetchMode = 'off' | 'native' | 'mcp';

export const WEB_FETCH_MODES: WebFetchMode[] = ['off', 'native', 'mcp'];

/**
 * OS-level isolation for Bash commands (macOS Seatbelt). Independent of the
 * permission gate: the gate decides what may run, the sandbox bounds what a
 * running command can touch (writes → cwd+tmp, network → blocked by default).
 */
export interface SandboxConfig {
  /** Wrap Bash commands in the OS sandbox. CLI: --sandbox / --no-sandbox. */
  bash: 'off' | 'on';
  /** Allow network access inside sandboxed commands. */
  allowNetwork: boolean;
  /** Extra directories sandboxed commands may write to (absolute paths). */
  extraWritePaths: string[];
}

export interface HarnessConfig {
  defaultProvider: string;
  defaultModel?: string;
  providers: Record<string, ProviderConfig>;
  /** VRAM guard: effective num_ctx = min(profile.contextLength, this). */
  contextLength: number;
  /** Set only by the user (file or --system); when absent the CLI picks an agent/chat default. */
  systemPrompt?: string;
  permissionMode: PermissionMode;
  /** Model steps allowed per user turn before the loop guard stops. */
  maxSteps: number;
  /** Persist conversations to .harness/sessions/*.jsonl (resume with --resume). */
  saveSessions: boolean;
  compaction: CompactionSettings;
  /** Subagent options: a smaller model for explore, and its step budget. */
  agents?: {
    exploreModel?: string;
    maxSteps?: number;
  };
  /** Web access for the model (see WebFetchMode). CLI: --web <mode>. */
  webFetch: WebFetchMode;
  /** Bash isolation (see SandboxConfig). */
  sandbox: SandboxConfig;
  /** File-state snapshots before mutating tool calls (/rewind restores). */
  checkpoints: 'on' | 'off';
  /** MCP servers to connect over stdio; their tools register as mcp__name__tool. */
  mcpServers?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
  /** Profile overrides keyed by exact model id or family name. */
  models?: Record<string, Partial<ModelProfile>>;
}

/**
 * Chat-only fallback (models without native tool calls). Deliberately static —
 * no date, no cwd — so the prompt prefix is byte-identical across sessions
 * (prefix-cache friendly).
 */
export const DEFAULT_SYSTEM_PROMPT =
  'You are a helpful assistant running on a locally hosted model. Be direct and concise.';

const DEFAULTS: HarnessConfig = {
  defaultProvider: 'ollama',
  providers: {
    ollama: { type: 'ollama', baseUrl: 'http://localhost:11434' },
    llamacpp: { type: 'llamacpp', baseUrl: 'http://localhost:8080' },
    vllm: { type: 'vllm', baseUrl: 'http://localhost:8000' },
    // Apple MLX (mlx_lm.server). 8081 avoids llama.cpp's default 8080.
    mlx: { type: 'mlx', baseUrl: 'http://localhost:8081' },
  },
  contextLength: 32768,
  permissionMode: 'ask',
  maxSteps: 20,
  saveSessions: true,
  compaction: DEFAULT_COMPACTION,
  webFetch: 'off',
  sandbox: { bash: 'off', allowNetwork: false, extraWritePaths: [] },
  checkpoints: 'on',
};

export const CONFIG_FILENAME = 'harness.config.json';

/** Load config from ./harness.config.json when present, merged over defaults. */
export function loadConfig(cwd: string = process.cwd()): HarnessConfig {
  const file = path.join(cwd, CONFIG_FILENAME);
  if (!fs.existsSync(file)) return structuredClone(DEFAULTS);
  let user: Partial<HarnessConfig>;
  try {
    user = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`Failed to parse ${file}: ${(e as Error).message}`);
  }
  const merged: HarnessConfig = {
    ...structuredClone(DEFAULTS),
    ...user,
    providers: { ...structuredClone(DEFAULTS.providers), ...(user.providers ?? {}) },
    compaction: { ...DEFAULT_COMPACTION, ...(user.compaction ?? {}) },
    sandbox: { ...structuredClone(DEFAULTS.sandbox), ...(user.sandbox ?? {}) },
  };
  if (!merged.providers[merged.defaultProvider]) {
    throw new Error(
      `defaultProvider "${merged.defaultProvider}" is not defined in providers (${Object.keys(merged.providers).join(', ')})`,
    );
  }
  if (!WEB_FETCH_MODES.includes(merged.webFetch)) {
    throw new Error(`invalid webFetch "${merged.webFetch}" — use one of: ${WEB_FETCH_MODES.join(', ')}`);
  }
  if (merged.sandbox.bash !== 'off' && merged.sandbox.bash !== 'on') {
    throw new Error(`invalid sandbox.bash "${merged.sandbox.bash}" — use "off" or "on"`);
  }
  if (merged.checkpoints !== 'on' && merged.checkpoints !== 'off') {
    throw new Error(`invalid checkpoints "${merged.checkpoints}" — use "on" or "off"`);
  }
  return merged;
}

/**
 * MCP servers to actually connect: in webFetch 'mcp' mode a default fetch
 * server rides along unless the user already configured one named "fetch".
 */
export function effectiveMcpServers(config: HarnessConfig): NonNullable<HarnessConfig['mcpServers']> {
  const servers = { ...(config.mcpServers ?? {}) };
  if (config.webFetch === 'mcp' && !servers.fetch) {
    servers.fetch = { command: 'uvx', args: ['mcp-server-fetch'] };
  }
  return servers;
}

export function effectiveContextLength(profile: ResolvedProfile, config: HarnessConfig): number {
  return Math.min(profile.contextLength, config.contextLength);
}
