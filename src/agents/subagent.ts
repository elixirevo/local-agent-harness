import { effectiveContextLength, type HarnessConfig } from '../config/config.js';
import { ReminderQueue } from '../context/reminders.js';
import { runTurn, type AgentSession } from '../core/loop.js';
import { resolveProfile } from '../models/profile.js';
import { PermissionGate } from '../permissions/gate.js';
import type { ProviderAdapter } from '../providers/types.js';
import { bashTool } from '../tools/bash.js';
import { globTool } from '../tools/glob.js';
import { grepTool } from '../tools/grep.js';
import { readTool } from '../tools/read.js';
import { ToolRegistry } from '../tools/registry.js';
import { exploreSystemPrompt, verifySystemPrompt } from './prompts.js';

export type SubagentType = 'explore' | 'verify';

export const SUBAGENT_TYPES: SubagentType[] = ['explore', 'verify'];

export interface SubagentDeps {
  provider: ProviderAdapter;
  config: HarnessConfig;
  cwd: string;
  /** Model of the calling session; explore may use config.agents.exploreModel instead. */
  parentModel: string;
}

export interface SubagentResult {
  report: string;
  verdict?: 'PASS' | 'FAIL' | 'PARTIAL';
  steps: number;
  toolCalls: number;
  guardStopped: boolean;
  model: string;
}

const SUBAGENT_MAX_STEPS = 12;

/**
 * Run a scoped nested agent. The tool set is the code half of the prompt's
 * scope limits: explore gets read-only tools behind a readonly gate; verify
 * adds Bash behind an auto gate with no askFn, so destructive commands are
 * denied rather than prompted. Neither registry contains the Agent tool —
 * a subagent can never spawn further subagents.
 */
export async function runSubagent(
  deps: SubagentDeps,
  type: SubagentType,
  prompt: string,
  signal?: AbortSignal,
): Promise<SubagentResult> {
  const model =
    type === 'explore' ? (deps.config.agents?.exploreModel ?? deps.parentModel) : deps.parentModel;
  const profile = resolveProfile(model, deps.config.models);

  const registry = new ToolRegistry().register(readTool).register(globTool).register(grepTool);
  let gate: PermissionGate;
  if (type === 'verify') {
    registry.register(bashTool);
    gate = new PermissionGate('auto', deps.cwd, undefined);
  } else {
    gate = new PermissionGate('readonly', deps.cwd, undefined);
  }

  const systemPrompt = type === 'explore' ? exploreSystemPrompt(deps.cwd) : verifySystemPrompt(deps.cwd);
  const session: AgentSession = {
    provider: deps.provider,
    model,
    profile,
    contextLength: effectiveContextLength(profile, deps.config),
    think: profile.thinking === 'none' ? undefined : true,
    messages: [{ role: 'system', content: systemPrompt }],
    registry,
    gate,
    toolCtx: { cwd: deps.cwd, readFiles: new Map() },
    maxSteps: deps.config.agents?.maxSteps ?? SUBAGENT_MAX_STEPS,
    protocol: profile.nativeToolCalls ? 'native' : 'text',
    reminders: new ReminderQueue(),
    compaction: deps.config.compaction,
  };

  let steps = 0;
  let toolCalls = 0;
  let guardStopped = false;
  let stepText = '';
  let lastText = '';
  for await (const ev of runTurn(session, prompt, signal)) {
    switch (ev.type) {
      case 'text':
        stepText += ev.text;
        break;
      case 'step':
        steps++;
        if (stepText.trim()) lastText = stepText;
        stepText = '';
        break;
      case 'tool_start':
        toolCalls++;
        break;
      case 'guard':
        guardStopped = true;
        break;
      default:
        break;
    }
  }
  if (stepText.trim()) lastText = stepText;

  const report = lastText.trim() || '(the subagent produced no final report)';
  return {
    report,
    verdict: type === 'verify' ? parseVerdict(report) : undefined,
    steps,
    toolCalls,
    guardStopped,
    model,
  };
}

export function parseVerdict(report: string): 'PASS' | 'FAIL' | 'PARTIAL' | undefined {
  const matches = [...report.matchAll(/^\s*VERDICT:\s*(PASS|FAIL|PARTIAL)\s*$/gim)];
  const last = matches.at(-1);
  return last ? (last[1].toUpperCase() as 'PASS' | 'FAIL' | 'PARTIAL') : undefined;
}
