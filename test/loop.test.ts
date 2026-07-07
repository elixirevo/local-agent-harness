import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_COMPACTION, type CompactionSettings } from '../src/context/budget.js';
import { ReminderQueue } from '../src/context/reminders.js';
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

const twoToolStep = (...calls: ToolCall[]): ChatChunk[] => [
  ...calls.map((c): ChatChunk => ({ type: 'tool_call', call: c })),
  { type: 'done', stopReason: 'tool_calls' },
];

function makeSession(
  provider: ProviderAdapter,
  toolCtx: ToolContext,
  opts: {
    mode?: PermissionMode;
    maxSteps?: number;
    ask?: (s: string) => Promise<boolean>;
    protocol?: 'native' | 'text' | 'none';
    compaction?: Partial<CompactionSettings>;
  } = {},
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
    protocol: opts.protocol ?? 'native',
    reminders: new ReminderQueue(),
    compaction: { ...DEFAULT_COMPACTION, ...opts.compaction },
  };
}

async function collectEvents(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

import type { Tool } from '../src/tools/types.js';

/** Read-only tool that blocks until released, recording enter/exit order. */
function barrierTool(name: string, log: string[]): { tool: Tool; releaseAll: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const tool: Tool = {
    name,
    isReadOnly: true,
    inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
    description: () => name,
    summarize: (input) => String(input.id ?? ''),
    async call(input) {
      log.push(`enter ${input.id}`);
      await gate;
      log.push(`exit ${input.id}`);
      return { ok: true, output: `done ${input.id}` };
    },
  };
  return { tool, releaseAll: release };
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

  it('tells the model a repeated successful mutation is already applied', async () => {
    const { dir, ctx } = tmpCtx();
    seed(dir, { 'a.ts': 'v1' });
    const edit = () => toolStep(call('c', 'Edit', { file_path: 'a.ts', old_string: 'v1', new_string: 'v2' }));
    const provider = new ScriptedProvider([
      toolStep(call('r', 'Read', { file_path: 'a.ts' })),
      edit(), // succeeds
      edit(), // identical retry of a successful mutation
      textStep('ok'),
    ]);
    const session = makeSession(provider, ctx);
    await collectEvents(runTurn(session, 'edit it'));
    const retryMsg = provider.received[3].messages.filter((m) => m.role === 'tool').at(-1);
    expect(retryMsg?.content).toContain('already SUCCEEDED');
    expect(retryMsg?.content).toContain('move on to the next step');
    expect(fs.readFileSync(path.join(dir, 'a.ts'), 'utf8')).toBe('v2');
  });

  it('unblocks a failed Edit after the model satisfies the Read precondition', async () => {
    const { dir, ctx } = tmpCtx();
    seed(dir, { 'a.ts': 'const RETRIES = 3;' });
    const edit = () =>
      toolStep(call('c', 'Edit', { file_path: 'a.ts', old_string: 'RETRIES = 3', new_string: 'RETRIES = 5' }));
    const provider = new ScriptedProvider([
      edit(), // fails: not read yet
      toolStep(call('r', 'Read', { file_path: 'a.ts' })), // satisfies the precondition
      edit(), // identical retry — outcome now differs, must RUN not intercept
      textStep('done'),
    ]);
    const session = makeSession(provider, ctx);
    const events = await collectEvents(runTurn(session, 'bump retries'));
    const ends = events.filter((e) => e.type === 'tool_end');
    expect(ends.map((e) => e.ok)).toEqual([false, true, true]);
    expect(fs.readFileSync(path.join(dir, 'a.ts'), 'utf8')).toBe('const RETRIES = 5;');
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

  it('prepends queued reminders to the next user message only', async () => {
    const { ctx } = tmpCtx();
    const provider = new ScriptedProvider([textStep('hi'), textStep('again')]);
    const session = makeSession(provider, ctx);
    session.reminders.enqueue('startup context here');
    await collectEvents(runTurn(session, 'first'));
    await collectEvents(runTurn(session, 'second'));
    const users = provider.received[1].messages.filter((m) => m.role === 'user');
    expect(users[0].content).toContain('<system-reminder>');
    expect(users[0].content).toContain('startup context here');
    expect(users[0].content).toContain('first');
    expect(users[1].content).toBe('second'); // queue drained — no reminder repeated
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

  it('sends no native tool defs under the text protocol', async () => {
    const { ctx } = tmpCtx();
    const provider = new ScriptedProvider([textStep('plain chat')]);
    const session = makeSession(provider, ctx, { protocol: 'text' });
    await collectEvents(runTurn(session, 'hi'));
    expect(provider.received[0].toolNames).toEqual([]);
  });

  it('executes a text-protocol tool call and returns the result as a user message', async () => {
    const { dir, ctx } = tmpCtx();
    seed(dir, { 'a.ts': 'const x = 1;' });
    const provider = new ScriptedProvider([
      textStep('Let me look.\n<tool_call>\n{"name": "Read", "arguments": {"file_path": "a.ts"}}\n</tool_call>'),
      textStep('It defines x = 1.'),
    ]);
    const session = makeSession(provider, ctx, { protocol: 'text' });
    const events = await collectEvents(runTurn(session, 'what is in a.ts?'));
    expect(events.some((e) => e.type === 'tool_start' && e.name === 'Read')).toBe(true);

    const second = provider.received[1].messages;
    expect(second.some((m) => m.role === 'tool')).toBe(false); // no tool role in text protocol
    const resultMsg = second.at(-1)!;
    expect(resultMsg.role).toBe('user');
    expect(resultMsg.content).toContain('<tool_result name="Read">');
    expect(resultMsg.content).toContain('const x = 1;');
    // the assistant message keeps its own tool_call block verbatim
    expect(second.at(-2)?.content).toContain('<tool_call>');
  });

  it('clears old tool results mid-turn when the budget tightens (FRC)', async () => {
    const { dir, ctx } = tmpCtx();
    seed(dir, { 'big.txt': 'data '.repeat(500) }); // ~2500 chars of tool result
    const provider = new ScriptedProvider([
      toolStep(call('c1', 'Read', { file_path: 'big.txt' })),
      textStep('done'),
    ]);
    const session = makeSession(provider, ctx, {
      compaction: { keepRecentResults: 0, frcThreshold: 0.3, threshold: 10, reserveTokens: 0 },
    });
    session.contextLength = 2000;
    const events = await collectEvents(runTurn(session, 'read the big file'));
    const notice = events.find((e) => e.type === 'notice');
    expect(notice?.message).toContain('cleared 1 old tool result');
    const toolMsg = session.messages.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toContain('cleared to save context');
  });

  it('auto-compacts mid-turn past the threshold and continues the turn', async () => {
    const { dir, ctx } = tmpCtx();
    seed(dir, { 'big.txt': 'data '.repeat(500) });
    const summary = [
      '## 1. Task and intent\nread big file',
      '## 2. Files and code\nbig.txt',
      '## 3. What was tried\nRead',
      '## 4. User feedback\nnone',
      '## 5. Current state\nreading',
      '## 6. Next step\n"read the big file"',
    ].join('\n');
    const provider = new ScriptedProvider([
      toolStep(call('c1', 'Read', { file_path: 'big.txt' })),
      [{ type: 'text', text: summary }, { type: 'done', stopReason: 'stop' }],
      textStep('all done'),
    ]);
    const compacted: number[] = [];
    const session = makeSession(provider, ctx, {
      compaction: { keepRecentResults: 5, frcThreshold: 10, threshold: 0.5, reserveTokens: 0 },
    });
    session.contextLength = 600;
    session.transcriptPath = '/tmp/t.jsonl';
    session.onCompacted = (m) => compacted.push(m.length);

    const events = await collectEvents(runTurn(session, 'read the big file'));

    const notices = events.filter((e) => e.type === 'notice').map((e) => e.message);
    expect(notices.some((m) => m.includes('compacted ~'))).toBe(true);
    // the summarize request is the 2nd provider call: tool-free, compact prompt last
    expect(provider.received[1].toolNames).toEqual([]);
    expect(provider.received[1].messages.at(-1)?.content).toContain('CRITICAL: Respond with TEXT ONLY');
    // post-compact request carries the summary instead of the old messages
    const finalReq = provider.received[2].messages;
    expect(finalReq.some((m) => m.content.includes('# Conversation summary'))).toBe(true);
    expect(compacted).toHaveLength(1);
    expect(session.toolCtx.readFiles.size).toBe(0); // forced re-reads after compaction
    expect(events.filter((e) => e.type === 'text').map((e) => e.text).join('')).toBe('all done');
  });

  it('sends a format reminder on malformed text calls and aborts after three', async () => {
    const { ctx } = tmpCtx();
    const bad = () => textStep('<tool_call>\n{not json at all\n</tool_call>');
    const provider = new ScriptedProvider([bad(), bad(), bad(), textStep('never reached')]);
    const session = makeSession(provider, ctx, { protocol: 'text' });
    const events = await collectEvents(runTurn(session, 'go'));

    const reminderMsg = provider.received[1].messages.at(-1)!;
    expect(reminderMsg.role).toBe('user');
    expect(reminderMsg.content).toContain('could not be parsed');
    const guard = events.find((e) => e.type === 'guard');
    expect(guard?.message).toContain('unparseable');
    expect(provider.received).toHaveLength(3);
  });
});

describe('parallel tool execution', () => {
  it('runs a read-only batch concurrently and appends results in call order', async () => {
    const { ctx } = tmpCtx();
    const log: string[] = [];
    const { tool, releaseAll } = barrierTool('SlowRead', log);
    const provider = new ScriptedProvider([
      twoToolStep(call('a', 'SlowRead', { id: 'A' }), call('b', 'SlowRead', { id: 'B' })),
      textStep('both done'),
    ]);
    const session = makeSession(provider, ctx);
    session.registry.register(tool);

    const run = collectEvents(runTurn(session, 'read both'));
    // Give both calls a tick to enter, then release. If execution were
    // sequential, only A would have entered before the release.
    await new Promise((r) => setTimeout(r, 20));
    expect(log).toEqual(['enter A', 'enter B']);
    releaseAll();
    await run;

    const toolMsgs = provider.received[1].messages.filter((m) => m.role === 'tool');
    expect(toolMsgs.map((m) => m.toolCallId)).toEqual(['a', 'b']); // order preserved
    expect(toolMsgs[0].content).toContain('done A');
    expect(toolMsgs[1].content).toContain('done B');
  });

  it('keeps a batch sequential when it contains a mutation', async () => {
    const { dir, ctx } = tmpCtx();
    seed(dir, { 'a.ts': 'v1' });
    const provider = new ScriptedProvider([
      twoToolStep(
        call('r', 'Read', { file_path: 'a.ts' }),
        call('w', 'Write', { file_path: 'b.ts', content: 'new' }),
      ),
      textStep('done'),
    ]);
    const session = makeSession(provider, ctx);
    const events = await collectEvents(runTurn(session, 'read and write'));
    // Both still execute and succeed; the point is correctness, not timing.
    expect(events.filter((e) => e.type === 'tool_end' && e.ok)).toHaveLength(2);
    expect(fs.readFileSync(path.join(dir, 'b.ts'), 'utf8')).toBe('new');
  });
});
