import type { ResolvedProfile } from '../models/profile.js';
import type { PermissionGate } from '../permissions/gate.js';
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
}

export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_start'; name: string; summary: string }
  | { type: 'tool_end'; name: string; ok: boolean; summary: string }
  | { type: 'step'; usage?: Usage; wallMs: number; stopReason: StopReason }
  | { type: 'guard'; message: string };

const MAX_TOOL_OUTPUT_CHARS = 30000;

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
  session.messages.push({ role: 'user', content: userInput });
  const guard = new RepeatGuard();
  const toolsEnabled = session.profile.nativeToolCalls;
  const toolDefs = toolsEnabled
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

    const started = Date.now();
    let content = '';
    const toolCalls: ToolCall[] = [];
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
    yield { type: 'step', usage, wallMs: Date.now() - started, stopReason };

    const assistant: ChatMessage = { role: 'assistant', content };
    if (toolCalls.length > 0) assistant.toolCalls = toolCalls;
    session.messages.push(assistant);

    if (toolCalls.length === 0 || stopReason === 'length' || stopReason === 'aborted') {
      if (stopReason === 'length') yield { type: 'guard', message: 'hit max output length' };
      return;
    }

    // Execute sequentially (local models are unreliable at parallel calls and
    // local inference gains nothing from concurrency). Every tool_call gets a
    // matching tool result even after a guard abort, to keep the protocol valid.
    let abortTurn = false;
    for (const call of toolCalls) {
      let result: string;
      let ok = false;
      let display = '';
      if (abortTurn) {
        result = toolError('skipped: the turn was stopped by a loop guard.');
      } else {
        const outcome = await executeCall(session, guard, call);
        result = outcome.output;
        ok = outcome.ok;
        display = outcome.display;
        abortTurn = outcome.abortTurn;
        yield { type: 'tool_start', name: call.name, summary: outcome.summary };
        yield { type: 'tool_end', name: call.name, ok, summary: display };
      }
      session.messages.push({ role: 'tool', content: result, toolCallId: call.id });
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
  const verdict = guard.checkRepeat(key);
  if (verdict !== 'run') {
    return fail(
      `you already ran ${call.name} with exactly these arguments in this turn and nothing has changed since — the outcome would be identical. Do not repeat the call: use the earlier result, try a different approach, or ask the user.`,
      tool && input ? tool.summarize(input, session.toolCtx) : call.name,
      verdict === 'abort',
    );
  }

  const outcome = await runCall(session, call, tool, input);
  // Only a mutation that actually executed changes state and resets what
  // "identical" means; failed or denied calls are recorded so retries trip
  // the repeat guard.
  guard.record(key, outcome.ok && tool !== undefined && !tool.isReadOnly);
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
  private seen = new Set<string>();
  private intercepts = 0;

  keyFor(call: ToolCall, input: Record<string, unknown> | undefined): string {
    // Stable-stringify parsed input so key reordering doesn't defeat the
    // guard; unparseable arguments fall back to the raw string.
    return input === undefined
      ? `${call.name}:raw:${call.arguments}`
      : `${call.name}:${stableStringify(input)}`;
  }

  checkRepeat(key: string): 'run' | 'intercept' | 'abort' {
    if (this.seen.has(key)) {
      this.intercepts++;
      return this.intercepts >= 3 ? 'abort' : 'intercept';
    }
    return 'run';
  }

  record(key: string, stateChanged: boolean): void {
    if (stateChanged) this.seen.clear();
    this.seen.add(key);
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}
