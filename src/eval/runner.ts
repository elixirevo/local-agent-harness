import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSubagent } from '../agents/subagent.js';
import { effectiveContextLength, type HarnessConfig } from '../config/config.js';
import { ReminderQueue } from '../context/reminders.js';
import { startupContext } from '../context/startup.js';
import { runTurn, type AgentSession } from '../core/loop.js';
import { sessionSandbox } from '../sandbox/exec.js';
import { resolveProfile, type PromptTier } from '../models/profile.js';
import { PermissionGate } from '../permissions/gate.js';
import { buildSystemPrompt, type ToolProtocol } from '../prompts/assemble.js';
import type { ProviderAdapter } from '../providers/types.js';
import { defaultRegistry } from '../tools/registry.js';
import type { Scenario } from './scenarios.js';

/** One cell of the evaluation matrix. */
export interface EvalConfig {
  model: string;
  tier: PromptTier;
  protocol: ToolProtocol;
  /** undefined = the profile's own temperature. */
  temperature?: number;
}

export function configKey(c: EvalConfig): string {
  return `${c.model} · ${c.tier} · ${c.protocol} · temp ${c.temperature ?? 'profile'}`;
}

export interface RunResult {
  scenarioId: string;
  config: EvalConfig;
  success: boolean;
  detail: string;
  steps: number;
  toolCalls: number;
  toolErrors: number;
  parseFailures: number;
  guardStops: number;
  compactions: number;
  frcClears: number;
  genTokens: number;
  prefillMsTotal: number;
  promptTokensMax: number;
  wallMs: number;
  timedOut: boolean;
  error?: string;
  /** Final answer text (truncated) — kept in the JSON for failure diagnosis. */
  answer: string;
}

const DEFAULT_SCENARIO_TIMEOUT_MS = 180_000;

export async function runScenario(
  scenario: Scenario,
  cfg: EvalConfig,
  provider: ProviderAdapter,
  harnessConfig: HarnessConfig,
): Promise<RunResult> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `harness-eval-${scenario.id}-`));
  const metrics: RunResult = {
    scenarioId: scenario.id,
    config: cfg,
    success: false,
    detail: '',
    steps: 0,
    toolCalls: 0,
    toolErrors: 0,
    parseFailures: 0,
    guardStops: 0,
    compactions: 0,
    frcClears: 0,
    genTokens: 0,
    prefillMsTotal: 0,
    promptTokensMax: 0,
    wallMs: 0,
    timedOut: false,
    answer: '',
  };
  const abort = new AbortController();
  const timeout = setTimeout(() => {
    metrics.timedOut = true;
    abort.abort();
  }, scenario.timeoutMs ?? DEFAULT_SCENARIO_TIMEOUT_MS);

  const started = Date.now();
  try {
    scenario.setup(dir);
    const finalAnswer = scenario.subagent
      ? await runSubagentScenario(scenario, cfg, provider, harnessConfig, dir, metrics, abort.signal)
      : await runLoopScenario(scenario, cfg, provider, harnessConfig, dir, metrics, abort.signal);
    metrics.answer = finalAnswer.slice(0, 800);
    const check = scenario.check(dir, finalAnswer);
    metrics.success = check.success && !metrics.timedOut;
    metrics.detail = metrics.timedOut ? `timeout · ${check.detail}` : check.detail;
  } catch (e) {
    metrics.error = (e as Error).message.slice(0, 200);
    metrics.detail = metrics.timedOut ? 'timeout' : `error: ${metrics.error}`;
  } finally {
    clearTimeout(timeout);
    metrics.wallMs = Date.now() - started;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return metrics;
}

async function runLoopScenario(
  scenario: Scenario,
  cfg: EvalConfig,
  provider: ProviderAdapter,
  harnessConfig: HarnessConfig,
  dir: string,
  metrics: RunResult,
  signal: AbortSignal,
): Promise<string> {
  const baseProfile = resolveProfile(cfg.model, harnessConfig.models);
  const profile = {
    ...baseProfile,
    promptTier: cfg.tier,
    ...(cfg.temperature !== undefined ? { temperature: cfg.temperature } : {}),
  };
  const registry = defaultRegistry();
  const contextLength = scenario.contextLength ?? effectiveContextLength(profile, harnessConfig);
  const session: AgentSession = {
    provider,
    model: cfg.model,
    profile,
    contextLength,
    think: profile.thinking === 'none' ? undefined : true,
    messages: [
      {
        role: 'system',
        content: buildSystemPrompt({ tier: cfg.tier, protocol: cfg.protocol, mode: 'auto', registry, cwd: dir }),
      },
    ],
    registry,
    gate: new PermissionGate('auto', dir, undefined),
    toolCtx: { cwd: dir, readFiles: new Map(), sandbox: sessionSandbox(dir, harnessConfig.sandbox) },
    maxSteps: harnessConfig.maxSteps,
    protocol: cfg.protocol,
    reminders: new ReminderQueue(),
    compaction: harnessConfig.compaction,
  };
  session.reminders.enqueue(startupContext(dir));

  let lastAnswer = '';
  for (const turn of scenario.turns) {
    if (signal.aborted) break;
    let stepText = '';
    let turnText = '';
    for await (const ev of runTurn(session, turn, signal)) {
      switch (ev.type) {
        case 'text':
          stepText += ev.text;
          break;
        case 'step':
          metrics.steps++;
          if (ev.usage?.completionTokens) metrics.genTokens += ev.usage.completionTokens;
          if (ev.usage?.promptMs) metrics.prefillMsTotal += ev.usage.promptMs;
          if (ev.usage?.promptTokens) {
            metrics.promptTokensMax = Math.max(metrics.promptTokensMax, ev.usage.promptTokens);
          }
          if (stepText.trim()) turnText = stepText;
          stepText = '';
          break;
        case 'tool_start':
          metrics.toolCalls++;
          break;
        case 'tool_end':
          if (!ev.ok) metrics.toolErrors++;
          break;
        case 'notice':
          if (ev.kind === 'malformed') metrics.parseFailures++;
          if (ev.kind === 'compact') metrics.compactions++;
          if (ev.kind === 'frc') metrics.frcClears++;
          break;
        case 'guard':
          metrics.guardStops++;
          break;
        default:
          break;
      }
    }
    if (stepText.trim()) turnText = stepText;
    if (turnText.trim()) lastAnswer = turnText;
  }
  return lastAnswer;
}

async function runSubagentScenario(
  scenario: Scenario,
  cfg: EvalConfig,
  provider: ProviderAdapter,
  harnessConfig: HarnessConfig,
  dir: string,
  metrics: RunResult,
  signal: AbortSignal,
): Promise<string> {
  // Subagent scenarios exercise the agents directly (deterministic harness
  // coverage); temperature/tier overrides ride the profile overrides table.
  const config: HarnessConfig = {
    ...harnessConfig,
    models: {
      ...harnessConfig.models,
      ...(cfg.temperature !== undefined
        ? { [cfg.model]: { ...harnessConfig.models?.[cfg.model], temperature: cfg.temperature } }
        : {}),
    },
  };
  const result = await runSubagent(
    { provider, config, cwd: dir, parentModel: cfg.model },
    scenario.subagent!,
    scenario.turns.join('\n'),
    signal,
  );
  metrics.steps = result.steps;
  metrics.toolCalls = result.toolCalls;
  if (result.guardStopped) metrics.guardStops++;
  return result.report;
}
