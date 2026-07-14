import type { CheckpointStore } from '../checkpoints/store.js';
import { compactSession } from '../compact/compact.js';
import { budgetStatus, type CompactionSettings } from '../context/budget.js';
import { clearOldToolResults } from '../context/frc.js';
import type { ReminderQueue } from '../context/reminders.js';
import { systemReminder } from '../context/reminders.js';
import type { ResolvedProfile } from '../models/profile.js';
import type { PermissionGate } from '../permissions/gate.js';
import type { ToolProtocol } from '../prompts/assemble.js';
import type {
  ChatMessage,
  ProviderAdapter,
  StopReason,
  ToolCall,
  Usage,
} from '../providers/types.js';
import { parseArguments, validateInput } from '../tools/schema.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { Tool, ToolContext } from '../tools/types.js';
import { extractTextToolCall, formatTextToolResult, FORMAT_REMINDER } from './textProtocol.js';

export interface AgentSession {
  provider: ProviderAdapter;
  model: string;
  profile: ResolvedProfile;
  contextLength: number;
  think: boolean | undefined;
  /** Append-only conversation history; [0] is the system prompt. */
  messages: ChatMessage[];
  registry: ToolRegistry;
  gate: PermissionGate;
  toolCtx: ToolContext;
  maxSteps: number;
  /** How tools reach the model: native tool-calls, the text protocol, or not at all. */
  protocol: ToolProtocol;
  reminders: ReminderQueue;
  compaction: CompactionSettings;
  /** Shown to the model after compaction as the full-history escape hatch. */
  transcriptPath?: string;
  /** Called after auto-compaction so the caller can persist the rebuilt history. */
  onCompacted?: (messages: ChatMessage[]) => void;
  /** When set, the tree is snapshotted before every mutating tool call. */
  checkpoints?: CheckpointStore;
}

export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_start'; name: string; summary: string }
  | { type: 'tool_end'; name: string; ok: boolean; summary: string }
  | { type: 'step'; usage?: Usage; wallMs: number; stopReason: StopReason; contextPct?: number }
  | { type: 'notice'; message: string; kind?: 'malformed' | 'frc' | 'compact' }
  | { type: 'guard'; message: string };

const MAX_TOOL_OUTPUT_CHARS = 30000;
const MAX_MALFORMED_ATTEMPTS = 3;

/**
 * One user turn: repeat model step → execute tool calls → feed results back,
 * until the model answers without tools or a guard stops the loop.
 * Mutates session.messages append-only; the caller owns rollback on error.
 */
export async function* runTurn(
  session: AgentSession,
  userInput: string,
  signal?: AbortSignal,
): AsyncGenerator<AgentEvent> {
  session.reminders.tick();
  session.messages.push({ role: 'user', content: session.reminders.drainPrefix() + userInput });

  const guard = new RepeatGuard();
  let malformedCount = 0;
  let compactedThisTurn = false; // at most one auto-compaction per turn (anti-thrash)
  const toolDefs =
    session.protocol === 'native'
      ? session.registry.toolDefs(session.gate.mode, session.profile.promptTier)
      : [];

  for (let step = 0; ; step++) {
    if (step >= session.maxSteps) {
      yield {
        type: 'guard',
        message: `stopped after ${session.maxSteps} steps in one turn (maxSteps) — ask the user how to continue`,
      };
      return;
    }

    const maintained = await maintainContext(session, toolDefs, !compactedThisTurn, signal);
    for (const notice of maintained.notices) yield { type: 'notice', ...notice };
    if (maintained.compacted) compactedThisTurn = true;
    const contextPct = maintained.pct;

    const started = Date.now();
    let content = '';
    const nativeCalls: ToolCall[] = [];
    let usage: Usage | undefined;
    let stopReason: StopReason = 'unknown';

    for await (const chunk of session.provider.chat({
      model: session.model,
      messages: session.messages,
      tools: toolDefs.length > 0 ? toolDefs : undefined,
      temperature: session.profile.temperature,
      contextLength: session.contextLength,
      thinking: session.profile.thinking,
      think: session.think,
      signal,
    })) {
      switch (chunk.type) {
        case 'text':
          content += chunk.text;
          yield chunk;
          break;
        case 'thinking':
          yield chunk;
          break;
        case 'tool_call':
          nativeCalls.push(chunk.call);
          break;
        case 'usage':
          usage = chunk.usage;
          break;
        case 'done':
          stopReason = chunk.stopReason;
          break;
      }
    }
    yield { type: 'step', usage, wallMs: Date.now() - started, stopReason, contextPct };

    // Resolve tool calls for this step: native chunks, or a text-protocol block.
    let calls = nativeCalls;
    let malformed: string | undefined;
    let extra = false;
    if (session.protocol === 'text' && calls.length === 0) {
      const extraction = extractTextToolCall(content, step);
      if (extraction.call) calls = [extraction.call];
      else if (extraction.malformed !== undefined) malformed = extraction.malformed;
      extra = extraction.extra;
    }

    // The assistant message keeps the raw content (including any text-protocol
    // block) — the model must see its own call verbatim next step.
    const assistant: ChatMessage = { role: 'assistant', content };
    if (session.protocol === 'native' && calls.length > 0) assistant.toolCalls = calls;
    session.messages.push(assistant);

    if (stopReason === 'length' || stopReason === 'aborted') {
      if (stopReason === 'length') yield { type: 'guard', message: 'hit max output length' };
      return;
    }

    if (malformed !== undefined) {
      malformedCount++;
      if (malformedCount >= MAX_MALFORMED_ATTEMPTS) {
        yield {
          type: 'guard',
          message: `stopped after ${MAX_MALFORMED_ATTEMPTS} unparseable tool calls — this model may be too weak for the text protocol`,
        };
        return;
      }
      yield { type: 'notice', message: 'malformed tool call — sent a format reminder', kind: 'malformed' };
      session.messages.push({ role: 'user', content: systemReminder(FORMAT_REMINDER) });
      continue;
    }

    if (calls.length === 0) return;

    const appendResult = (call: ToolCall, output: string): void => {
      if (session.protocol === 'native') {
        session.messages.push({ role: 'tool', content: output, toolCallId: call.id });
      } else {
        const note = extra ? '\n\n(note: only the first tool call was executed — one per response)' : '';
        session.messages.push({ role: 'user', content: formatTextToolResult(call.name, output) + note });
      }
    };

    // A batch of purely read-only calls (parallel reads/greps, or explore
    // subagents) is safe to run concurrently: reads don't change state, so the
    // guard's clear-on-mutation never races and result ordering is preserved
    // by appending in call order. Anything with a mutation stays sequential —
    // ordering and the guard's state reset both matter there.
    let abortTurn = false;
    if (calls.length > 1 && calls.every((c) => isParallelSafe(session, c))) {
      for (const call of calls) {
        yield { type: 'tool_start', name: call.name, summary: summarizeCall(session, call) };
      }
      const outcomes = await Promise.all(calls.map((c) => executeCall(session, guard, c)));
      for (let i = 0; i < calls.length; i++) {
        const outcome = outcomes[i];
        yield { type: 'tool_end', name: calls[i].name, ok: outcome.ok, summary: outcome.display };
        appendResult(calls[i], outcome.output);
        if (outcome.abortTurn) abortTurn = true;
      }
    } else {
      // Every tool_call gets a matching result even after a guard abort, to
      // keep the message protocol valid.
      for (const call of calls) {
        if (abortTurn) {
          appendResult(call, toolError('skipped: the turn was stopped by a loop guard.'));
          continue;
        }
        const outcome = await executeCall(session, guard, call);
        abortTurn = outcome.abortTurn;
        yield { type: 'tool_start', name: call.name, summary: outcome.summary };
        yield { type: 'tool_end', name: call.name, ok: outcome.ok, summary: outcome.display };
        appendResult(call, outcome.output);
      }
    }
    if (abortTurn) {
      yield {
        type: 'guard',
        message: 'stopped: the same tool call was repeated too many times — ask the user how to continue',
      };
      return;
    }
  }
}

/** Whether a call touches no state, so it can run concurrently with siblings. */
function isParallelSafe(session: AgentSession, call: ToolCall): boolean {
  const tool = session.registry.get(call.name);
  if (!tool) return false;
  const input = parseArguments(call.arguments);
  if (input === undefined) return false;
  const risk = tool.riskOf?.(input, session.toolCtx) ?? (tool.isReadOnly ? 'read' : 'mutate');
  return risk === 'read';
}

function summarizeCall(session: AgentSession, call: ToolCall): string {
  const tool = session.registry.get(call.name);
  const input = parseArguments(call.arguments);
  return tool && input ? tool.summarize(input, session.toolCtx) : call.name;
}

interface MaintainResult {
  notices: Array<{ message: string; kind: 'frc' | 'compact' }>;
  pct: number;
  compacted: boolean;
}

/**
 * Staged context reclamation before a model step: clear old tool results at
 * the lower threshold, compact at the higher one. Both replace
 * session.messages with new arrays (old objects untouched) so the caller's
 * turn-rollback snapshot stays valid.
 */
async function maintainContext(
  session: AgentSession,
  toolDefs: ReturnType<ToolRegistry['toolDefs']>,
  allowCompaction: boolean,
  signal?: AbortSignal,
): Promise<MaintainResult> {
  const settings = session.compaction;
  const pct = (u: number) => Math.round(u * 100);
  const notices: MaintainResult['notices'] = [];
  let compacted = false;
  let status = budgetStatus(session.messages, session.contextLength, settings, toolDefs);
  if (!settings.enabled) return { notices, pct: pct(status.usage), compacted };

  if (status.usage > settings.frcThreshold) {
    let frc = clearOldToolResults(session.messages, settings.keepRecentResults);
    if (frc.cleared > 0) session.messages = frc.messages;
    let cleared = frc.cleared;
    status = budgetStatus(session.messages, session.contextLength, settings, toolDefs);
    // Escalate before resorting to compaction: keep only the newest result.
    if (status.usage > settings.threshold && settings.keepRecentResults > 1) {
      frc = clearOldToolResults(session.messages, 1);
      if (frc.cleared > 0) {
        session.messages = frc.messages;
        cleared += frc.cleared;
        status = budgetStatus(session.messages, session.contextLength, settings, toolDefs);
      }
    }
    if (cleared > 0) {
      notices.push({
        message: `context ~${pct(status.usage)}% — cleared ${cleared} old tool result${cleared > 1 ? 's' : ''}`,
        kind: 'frc',
      });
    }
  }

  if (allowCompaction && status.usage > settings.threshold) {
    const preUsage = pct(status.usage);
    const result = await compactSession(session.messages, {
      provider: session.provider,
      model: session.model,
      contextLength: session.contextLength,
      thinking: session.profile.thinking,
      think: session.think,
      transcriptPath: session.transcriptPath,
      signal,
    });
    if (result.messages !== session.messages) {
      compacted = true;
      session.messages = result.messages;
      // Pre-compaction file contents are gone from context; force re-reads.
      session.toolCtx.readFiles.clear();
      session.onCompacted?.(result.messages);
      status = budgetStatus(session.messages, session.contextLength, settings, toolDefs);
      notices.push({
        message: `context ~${preUsage}% — compacted ~${result.beforeTokens} → ~${result.afterTokens} tok${result.degraded ? ' (summary failed validation — continuing with best effort)' : ''}${status.usage > 1 ? ' — still over budget; consider /clear' : ''}`,
        kind: 'compact',
      });
    }
  }
  return { notices, pct: pct(status.usage), compacted };
}

interface CallOutcome {
  ok: boolean;
  output: string;
  summary: string;
  display: string;
  abortTurn: boolean;
}

async function executeCall(
  session: AgentSession,
  guard: RepeatGuard,
  call: ToolCall,
): Promise<CallOutcome> {
  const fail = (msg: string, summary = '', abortTurn = false): CallOutcome => ({
    ok: false,
    output: toolError(msg),
    summary,
    display: firstLine(msg),
    abortTurn,
  });

  const tool = session.registry.get(call.name);
  const input = parseArguments(call.arguments);

  // Repeat check first — before the gate — so a user who denied a call once
  // is not asked again about the model's identical retry.
  const key = guard.keyFor(call, input);
  const { verdict, succeededBefore } = guard.checkRepeat(key);
  if (verdict !== 'run') {
    return fail(
      succeededBefore
        ? `${call.name} with these exact arguments already SUCCEEDED earlier in this turn — the change is applied. Do not run it again; move on to the next step (e.g. verify the result or report you are done).`
        : `you already ran ${call.name} with exactly these arguments in this turn and nothing has changed since — the outcome would be identical. Do not repeat the call: use the earlier result, try a different approach, or ask the user.`,
      tool && input ? tool.summarize(input, session.toolCtx) : call.name,
      verdict === 'abort',
    );
  }

  const outcome = await runCall(session, call, tool, input);
  // Only a mutation that actually executed changes state and resets what
  // "identical" means; failed or denied calls are recorded so retries trip
  // the repeat guard.
  guard.record(key, {
    stateChanged: outcome.ok && tool !== undefined && !tool.isReadOnly,
    ok: outcome.ok,
    path: typeof input?.file_path === 'string' ? (input.file_path as string) : undefined,
  });
  return outcome;
}

async function runCall(
  session: AgentSession,
  call: ToolCall,
  tool: Tool | undefined,
  input: Record<string, unknown> | undefined,
): Promise<CallOutcome> {
  const fail = (msg: string, summary = '', abortTurn = false): CallOutcome => ({
    ok: false,
    output: toolError(msg),
    summary,
    display: firstLine(msg),
    abortTurn,
  });

  if (!tool) {
    return fail(
      `unknown tool "${call.name}". Available tools: ${session.registry
        .list(session.gate.mode)
        .map((t) => t.name)
        .join(', ')}.`,
      call.name,
    );
  }
  if (input === undefined) {
    return fail(
      `could not parse the arguments for ${call.name} as a JSON object. Send arguments as a single JSON object matching the tool schema.`,
      tool.name,
    );
  }
  const summary = tool.summarize(input, session.toolCtx);

  const schemaErrors = validateInput(tool.inputSchema, input);
  if (schemaErrors.length > 0) {
    return fail(`invalid arguments for ${call.name}: ${schemaErrors.join('; ')}.`, summary);
  }

  const decision = await session.gate.check(tool, input, session.toolCtx);
  if (!decision.allowed) {
    return fail(
      `permission denied: ${decision.reason}. Do not retry the same call — adjust your approach or ask the user.`,
      summary,
    );
  }

  // Snapshot the tree before an approved mutation executes, so /rewind can
  // restore the state right before it. Best-effort: a checkpoint failure
  // must never block the tool.
  if (session.checkpoints) {
    const risk = tool.riskOf?.(input, session.toolCtx) ?? (tool.isReadOnly ? 'read' : 'mutate');
    if (risk !== 'read') {
      await session.checkpoints.snapshot(`${tool.name} ${summary}`.slice(0, 80)).catch(() => {});
    }
  }

  try {
    const result = await tool.call(input, session.toolCtx);
    if (!result.ok) return fail(result.output, summary);
    return {
      ok: true,
      output: truncateOutput(result.output),
      summary,
      display: result.display ?? 'done',
      abortTurn: false,
    };
  } catch (e) {
    return fail(`${call.name} failed: ${(e as Error).message}`, summary);
  }
}

function toolError(message: string): string {
  return `<tool_error>\n${message}\n</tool_error>`;
}

function truncateOutput(output: string): string {
  if (output.length <= MAX_TOOL_OUTPUT_CHARS) return output;
  return `${output.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n\n(output truncated at ${MAX_TOOL_OUTPUT_CHARS} characters — narrow the request to see more)`;
}

function firstLine(s: string): string {
  const line = s.split('\n', 1)[0];
  return line.length > 120 ? `${line.slice(0, 120)}…` : line;
}

/**
 * Loop guard against the classic small-model failure mode: re-running an
 * identical call whose outcome cannot have changed — repeated reads, or
 * retrying a call that just failed or was denied. Only a successfully
 * executed mutation resets the notion of "identical" (state actually moved).
 */
class RepeatGuard {
  private seen = new Map<string, { succeededMutation: boolean; ok: boolean; path?: string }>();
  private intercepts = 0;

  keyFor(call: ToolCall, input: Record<string, unknown> | undefined): string {
    // Stable-stringify parsed input so key reordering doesn't defeat the
    // guard; unparseable arguments fall back to the raw string.
    return input === undefined
      ? `${call.name}:raw:${call.arguments}`
      : `${call.name}:${stableStringify(input)}`;
  }

  checkRepeat(key: string): { verdict: 'run' | 'intercept' | 'abort'; succeededBefore: boolean } {
    const entry = this.seen.get(key);
    if (entry) {
      this.intercepts++;
      return {
        verdict: this.intercepts >= 3 ? 'abort' : 'intercept',
        succeededBefore: entry.succeededMutation,
      };
    }
    return { verdict: 'run', succeededBefore: false };
  }

  record(key: string, info: { stateChanged: boolean; ok: boolean; path?: string }): void {
    if (info.stateChanged) this.seen.clear();
    if (info.ok && info.path !== undefined) {
      // A successful call on a file can satisfy the precondition an earlier
      // call failed on (the fail-Edit → Read → retry-Edit sequence): the
      // retry's outcome is no longer "identical", so unblock it.
      for (const [k, v] of this.seen) {
        if (!v.ok && v.path === info.path) this.seen.delete(k);
      }
    }
    this.seen.set(key, { succeededMutation: info.stateChanged, ok: info.ok, path: info.path });
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}
