import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runTurn, type AgentEvent, type AgentSession } from '../src/core/loop.js';
import { resolveProfile } from '../src/models/profile.js';
import { PermissionGate, type PermissionMode } from '../src/permissions/gate.js';
import type {
  ChatChunk,
  ChatRequest,
  ProviderAdapter,
  ProviderCaps,
  ToolCall,
} from '../src/providers/types.js';
import { defaultRegistry } from '../src/tools/registry.js';
import type { ToolContext } from '../src/tools/types.js';
import { seed, tmpCtx } from './toolHelpers.js';

/** Provider that replays scripted step responses and records every request. */
class ScriptedProvider implements ProviderAdapter {
  readonly name = 'scripted';
  readonly received: Array<{ messages: ChatRequest['messages']; toolNames: string[] }> = [];
  private steps: ChatChunk[][];

  constructor(steps: ChatChunk[][]) {
    this.steps = steps;
  }

  async *chat(req: ChatRequest): AsyncIterable<ChatChunk> {
    this.received.push({
      messages: JSON.parse(JSON.stringify(req.messages)),
      toolNames: (req.tools ?? []).map((t) => t.name),
    });
    const step = this.steps.shift();
    if (!step) throw new Error('scripted provider ran out of steps');
    yield* step;
  }

  capabilities(): ProviderCaps {
    return { nativeToolCalls: true, grammar: false, tokenCount: false, reportsCacheHits: false };
  }

  async listModels(): Promise<string[]> {
    return [];
  }
}

const call = (id: string, name: string, args: object): ToolCall => ({
  id,
  name,
  arguments: JSON.stringify(args),
});

const toolStep = (...calls: ToolCall[]): ChatChunk[] => [
  ...calls.map((c): ChatChunk => ({ type: 'tool_call', call: c })),
  { type: 'done', stopReason: 'tool_calls' },
];

const textStep = (text: string): ChatChunk[] => [
  { type: 'text', text },
  { type: 'done', stopReason: 'stop' },
];

function makeSession(
  provider: ProviderAdapter,
  toolCtx: ToolContext,
  opts: { mode?: PermissionMode; maxSteps?: number; ask?: (s: string) => Promise<boolean> } = {},
): AgentSession {
  const mode = opts.mode ?? 'auto';
  return {
    provider,
    model: 'scripted-model',
    profile: { ...resolveProfile('scripted-model'), nativeToolCalls: true },
    contextLength: 8192,
    think: undefined,
    messages: [{ role: 'system', content: 'sys' }],
    registry: defaultRegistry(),
    gate: new PermissionGate(mode, toolCtx.cwd, opts.ask),
    toolCtx,
    maxSteps: opts.maxSteps ?? 20,
  };
}

async function collectEvents(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

describe('runTurn', () => {
  it('answers a text-only turn and records history', async () => {
    const { ctx } = tmpCtx();
    const provider = new ScriptedProvider([textStep('Just an answer.')]);
    const session = makeSession(provider, ctx);
    const events = await collectEvents(runTurn(session, 'question?'));
    expect(events.filter((e) => e.type === 'text')).toHaveLength(1);
    expect(session.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant']);
    expect(provider.received[0].toolNames).toEqual(['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash']);
  });

  it('executes a tool call, feeds the result back, and finishes', async () => {
    const { dir, ctx } = tmpCtx();
    seed(dir, { 'src/a.ts': 'const answer = 42;' });
    const provider = new ScriptedProvider([
      toolStep(call('c1', 'Read', { file_path: 'src/a.ts' })),
      textStep('The answer is 42.'),
    ]);
    const session = makeSession(provider, ctx);
    const events = await collectEvents(runTurn(session, 'what is in a.ts?'));

    expect(events.some((e) => e.type === 'tool_start' && e.name === 'Read')).toBe(true);
    expect(events.some((e) => e.type === 'tool_end' && e.ok)).toBe(true);
    // second request must contain the tool result for the model to read
    const second = provider.received[1];
    const toolMsg = second.messages.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toContain('const answer = 42;');
    expect(toolMsg?.toolCallId).toBe('c1');
    expect(session.messages.map((m) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
      'assistant',
    ]);
  });

  it('feeds schema errors back as tool_error instead of crashing', async () => {
    const { ctx } = tmpCtx();
    const provider = new ScriptedProvider([
      toolStep(call('c1', 'Read', {})), // missing file_path
      textStep('ok'),
    ]);
    const session = makeSession(provider, ctx);
    const events = await collectEvents(runTurn(session, 'go'));
    const end = events.find((e) => e.type === 'tool_end');
    expect(end && !end.ok).toBe(true);
    const toolMsg = provider.received[1].messages.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toContain('<tool_error>');
    expect(toolMsg?.content).toContain('missing required parameter "file_path"');
  });

  it('reports unknown tools with the available list', async () => {
    const { ctx } = tmpCtx();
    const provider = new ScriptedProvider([toolStep(call('c1', 'Fetch', { url: 'x' })), textStep('ok')]);
    const session = makeSession(provider, ctx);
    await collectEvents(runTurn(session, 'go'));
    const toolMsg = provider.received[1].messages.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toContain('unknown tool "Fetch"');
    expect(toolMsg?.content).toContain('Read, Write, Edit, Glob, Grep, Bash');
  });

  it('intercepts identical repeated read-only calls and aborts after three', async () => {
    const { dir, ctx } = tmpCtx();
    seed(dir, { 'a.ts': 'x' });
    const readCall = () => toolStep(call('c', 'Read', { file_path: 'a.ts' }));
    const provider = new ScriptedProvider([
      readCall(), // runs
      readCall(), // intercept 1
      readCall(), // intercept 2
      readCall(), // intercept 3 → abort
      textStep('should never be requested'),
    ]);
    const session = makeSession(provider, ctx);
    const events = await collectEvents(runTurn(session, 'loop!'));

    const guard = events.find((e) => e.type === 'guard');
    expect(guard?.message).toContain('repeated');
    expect(provider.received).toHaveLength(4); // the 5th scripted step is never pulled
    const lastTool = session.messages.filter((m) => m.role === 'tool').at(-1);
    expect(lastTool?.content).toContain('Do not repeat the call');
  });

  it('lets an identical read run again after a mutation invalidates it', async () => {
    const { dir, ctx } = tmpCtx();
    seed(dir, { 'a.ts': 'v1' });
    const provider = new ScriptedProvider([
      toolStep(call('c1', 'Read', { file_path: 'a.ts' })),
      toolStep(call('c2', 'Edit', { file_path: 'a.ts', old_string: 'v1', new_string: 'v2' })),
      toolStep(call('c3', 'Read', { file_path: 'a.ts' })), // same input as c1 — must run
      textStep('done'),
    ]);
    const session = makeSession(provider, ctx);
    const events = await collectEvents(runTurn(session, 'edit then verify'));
    expect(events.filter((e) => e.type === 'tool_end' && !e.ok)).toHaveLength(0);
    const lastToolMsg = provider.received[3].messages.filter((m) => m.role === 'tool').at(-1);
    expect(lastToolMsg?.content).toContain('v2');
  });

  it('stops at maxSteps with a guard event', async () => {
    const { dir, ctx } = tmpCtx();
    seed(dir, { 'a.ts': 'x', 'b.ts': 'y', 'c.ts': 'z' });
    const provider = new ScriptedProvider([
      toolStep(call('c1', 'Read', { file_path: 'a.ts' })),
      toolStep(call('c2', 'Read', { file_path: 'b.ts' })),
      toolStep(call('c3', 'Read', { file_path: 'c.ts' })),
    ]);
    const session = makeSession(provider, ctx, { maxSteps: 3 });
    const events = await collectEvents(runTurn(session, 'go'));
    const guard = events.find((e) => e.type === 'guard');
    expect(guard?.message).toContain('maxSteps');
    expect(provider.received).toHaveLength(3);
  });

  it('denies mutations via the gate and tells the model not to retry', async () => {
    const { dir, ctx } = tmpCtx();
    const provider = new ScriptedProvider([
      toolStep(call('c1', 'Write', { file_path: 'x.ts', content: 'boom' })),
      textStep('understood'),
    ]);
    const session = makeSession(provider, ctx, { mode: 'ask', ask: async () => false });
    await collectEvents(runTurn(session, 'write something'));
    expect(fs.existsSync(path.join(dir, 'x.ts'))).toBe(false);
    const toolMsg = provider.received[1].messages.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toContain('permission denied');
    expect(toolMsg?.content).toContain('Do not retry');
  });

  it('intercepts an identical retry of a denied mutation without re-asking the user', async () => {
    const { dir, ctx } = tmpCtx();
    let asks = 0;
    const write = () => toolStep(call('c', 'Write', { file_path: 'x.ts', content: 'boom' }));
    const provider = new ScriptedProvider([write(), write(), textStep('giving up')]);
    const session = makeSession(provider, ctx, {
      mode: 'ask',
      ask: async () => {
        asks++;
        return false;
      },
    });
    await collectEvents(runTurn(session, 'write something'));
    expect(asks).toBe(1); // the retry is intercepted before reaching the gate
    expect(fs.existsSync(path.join(dir, 'x.ts'))).toBe(false);
    const retryMsg = provider.received[2].messages.filter((m) => m.role === 'tool').at(-1);
    expect(retryMsg?.content).toContain('Do not repeat the call');
  });

  it('intercepts an identical retry of a failed call', async () => {
    const { dir, ctx } = tmpCtx();
    seed(dir, { 'a.ts': 'hello' });
    const badEdit = () =>
      toolStep(call('c', 'Edit', { file_path: 'a.ts', old_string: 'absent', new_string: 'x' }));
    const provider = new ScriptedProvider([
      toolStep(call('r', 'Read', { file_path: 'a.ts' })),
      badEdit(), // fails: old_string not found
      badEdit(), // identical retry → intercepted
      textStep('ok'),
    ]);
    const session = makeSession(provider, ctx);
    await collectEvents(runTurn(session, 'edit'));
    const retryMsg = provider.received[3].messages.filter((m) => m.role === 'tool').at(-1);
    expect(retryMsg?.content).toContain('Do not repeat the call');
  });

  it('excludes mutating tools from the request in readonly mode (double defense)', async () => {
    const { ctx } = tmpCtx();
    const provider = new ScriptedProvider([textStep('looked around')]);
    const session = makeSession(provider, ctx, { mode: 'readonly' });
    await collectEvents(runTurn(session, 'explore'));
    expect(provider.received[0].toolNames).toEqual(['Read', 'Glob', 'Grep']);
  });

  it('asks before auto-mode mutations that escape the working directory', async () => {
    const { dir, ctx } = tmpCtx();
    const asked: string[] = [];
    const outside = path.join(dir, '..', `harness-escape-${path.basename(dir)}.txt`);
    const provider = new ScriptedProvider([
      toolStep(call('c1', 'Write', { file_path: outside, content: 'x' })),
      textStep('ok'),
    ]);
    const session = makeSession(provider, ctx, {
      mode: 'auto',
      ask: async (s) => {
        asked.push(s);
        return false;
      },
    });
    await collectEvents(runTurn(session, 'write outside'));
    expect(asked).toHaveLength(1);
    expect(fs.existsSync(outside)).toBe(false);
  });

  it('sends no tools for profiles without native tool calls', async () => {
    const { ctx } = tmpCtx();
    const provider = new ScriptedProvider([textStep('plain chat')]);
    const session = makeSession(provider, ctx);
    session.profile = { ...session.profile, nativeToolCalls: false };
    await collectEvents(runTurn(session, 'hi'));
    expect(provider.received[0].toolNames).toEqual([]);
  });
});
