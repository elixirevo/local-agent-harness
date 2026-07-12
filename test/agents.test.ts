import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAgentTool } from '../src/agents/agentTool.js';
import { parseVerdict, runSubagent, type SubagentDeps } from '../src/agents/subagent.js';
import { loadConfig } from '../src/config/config.js';
import { sandboxAvailable } from '../src/sandbox/exec.js';
import type {
  ChatChunk,
  ChatRequest,
  ProviderAdapter,
  ProviderCaps,
  ToolCall,
} from '../src/providers/types.js';
import { seed, tmpCtx } from './toolHelpers.js';

class ScriptedProvider implements ProviderAdapter {
  readonly name = 'scripted';
  readonly received: Array<{ system: string; toolNames: string[] }> = [];
  constructor(private steps: ChatChunk[][]) {}

  async *chat(req: ChatRequest): AsyncIterable<ChatChunk> {
    this.received.push({
      system: req.messages[0]?.role === 'system' ? req.messages[0].content : '',
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

const call = (name: string, args: object): ToolCall => ({ id: 'c1', name, arguments: JSON.stringify(args) });
const toolStep = (c: ToolCall): ChatChunk[] => [
  { type: 'tool_call', call: c },
  { type: 'done', stopReason: 'tool_calls' },
];
const textStep = (text: string): ChatChunk[] => [
  { type: 'text', text },
  { type: 'done', stopReason: 'stop' },
];

function deps(provider: ProviderAdapter, cwd: string, model = 'scripted-tools'): SubagentDeps {
  const config = loadConfig('/nonexistent'); // defaults only
  // scripted model must resolve to a tool-capable profile
  config.models = { [model]: { nativeToolCalls: true } };
  return { provider, config, cwd, parentModel: model };
}

describe('runSubagent', () => {
  it('explore gets read-only tools, a role prompt, and returns a labeled report', async () => {
    const { dir, ctx } = tmpCtx();
    seed(dir, { 'src/helpers.js': 'function formatPrice() {}' });
    const provider = new ScriptedProvider([
      toolStep(call('Grep', { pattern: 'formatPrice' })),
      textStep('Scope: searched for formatPrice\nResult: defined in src/helpers.js\nKey files: src/helpers.js'),
    ]);
    const result = await runSubagent(deps(provider, ctx.cwd), 'explore', 'find formatPrice');

    expect(provider.received[0].toolNames).toEqual(['Read', 'Glob', 'Grep']); // no Write/Edit/Bash/Agent
    expect(provider.received[0].system).toContain('READ-ONLY');
    expect(provider.received[0].system).toContain('exploration specialist');
    expect(result.report).toContain('src/helpers.js');
    expect(result.steps).toBe(2);
    expect(result.toolCalls).toBe(1);
    expect(result.verdict).toBeUndefined();
  });

  it('verify gets Bash, an adversarial prompt, and a parsed verdict', async () => {
    const { dir, ctx } = tmpCtx();
    seed(dir, { 'test.js': 'process.exit(1)' });
    const provider = new ScriptedProvider([
      toolStep(call('Bash', { command: 'node test.js' })),
      textStep('The test suite fails.\n\nVERDICT: FAIL'),
    ]);
    const result = await runSubagent(deps(provider, ctx.cwd), 'verify', 'verify the work');

    expect(provider.received[0].toolNames).toEqual(['Read', 'Glob', 'Grep', 'Bash']);
    expect(provider.received[0].system).toContain('try to break it');
    expect(result.verdict).toBe('FAIL');
  });

  it('verify denies destructive commands (auto gate without approval)', async () => {
    const { dir, ctx } = tmpCtx();
    seed(dir, { 'a.txt': 'data' });
    const provider = new ScriptedProvider([
      toolStep(call('Bash', { command: 'rm a.txt' })),
      textStep('Could not remove the file.\nVERDICT: PARTIAL'),
    ]);
    const result = await runSubagent(deps(provider, ctx.cwd), 'verify', 'clean up');
    expect(fs.existsSync(path.join(ctx.cwd, 'a.txt'))).toBe(true); // blocked
    expect(result.verdict).toBe('PARTIAL');
  });

  it('uses the configured explore model instead of the parent model', async () => {
    const { ctx } = tmpCtx();
    const provider = new ScriptedProvider([textStep('Scope: x\nResult: y\nKey files: z')]);
    const d = deps(provider, ctx.cwd);
    d.config.agents = { exploreModel: 'tiny-model' };
    const result = await runSubagent(d, 'explore', 'quick look');
    expect(result.model).toBe('tiny-model');
  });

  it('offers WebFetch to both subagent types when webFetch is native', async () => {
    const { ctx } = tmpCtx();
    for (const type of ['explore', 'verify'] as const) {
      const provider = new ScriptedProvider([textStep('Scope: x\nResult: y\nKey files: z\nVERDICT: PASS')]);
      const d = deps(provider, ctx.cwd);
      d.config.webFetch = 'native';
      await runSubagent(d, type, 'look something up');
      expect(provider.received[0].toolNames).toContain('WebFetch');
    }
  });

  it('keeps WebFetch out of subagents when webFetch is off, and out of the explore prompt', async () => {
    const { ctx } = tmpCtx();
    const provider = new ScriptedProvider([textStep('Scope: x\nResult: y\nKey files: z')]);
    const d = deps(provider, ctx.cwd); // defaults: webFetch 'off'
    await runSubagent(d, 'explore', 'quick look');
    expect(provider.received[0].toolNames).not.toContain('WebFetch');
    expect(provider.received[0].system).not.toContain('WebFetch');
  });

  it('mentions WebFetch in the explore prompt when enabled', async () => {
    const { ctx } = tmpCtx();
    const provider = new ScriptedProvider([textStep('Scope: x\nResult: y\nKey files: z')]);
    const d = deps(provider, ctx.cwd);
    d.config.webFetch = 'native';
    await runSubagent(d, 'explore', 'quick look');
    expect(provider.received[0].system).toContain('WebFetch');
  });

  it.skipIf(!sandboxAvailable())(
    'verify runs Bash inside a forced sandbox even with sandbox off in config',
    async () => {
      const { dir, ctx } = tmpCtx();
      const outside = fs.mkdtempSync(path.join(os.homedir(), '.sb-agents-'));
      try {
        const provider = new ScriptedProvider([
          toolStep(call('Bash', { command: `echo leak > ${outside}/leak.txt` })),
          textStep('Write failed.\nVERDICT: PARTIAL'),
        ]);
        const d = deps(provider, ctx.cwd); // config default: sandbox.bash 'off'
        await runSubagent(d, 'verify', 'try to write outside');
        expect(fs.existsSync(path.join(outside, 'leak.txt'))).toBe(false); // sandbox blocked it
        void dir;
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    },
  );
});

describe('parseVerdict', () => {
  it('takes the last verdict line, case-insensitively', () => {
    expect(parseVerdict('...\nVERDICT: PASS')).toBe('PASS');
    expect(parseVerdict('verdict: fail')).toBe('FAIL');
    expect(parseVerdict('VERDICT: PASS\nlater...\nVERDICT: FAIL')).toBe('FAIL');
    expect(parseVerdict('no verdict here')).toBeUndefined();
    expect(parseVerdict('the VERDICT: PASS mid-sentence')).toBeUndefined(); // must be its own line
  });
});

describe('Agent tool', () => {
  it('runs a subagent and annotates a missing verdict', async () => {
    const { ctx } = tmpCtx();
    const provider = new ScriptedProvider([textStep('I checked things but forgot the contract.')]);
    const tool = createAgentTool(() => deps(provider, ctx.cwd));
    const res = await tool.call({ agent_type: 'verify', prompt: 'check it' }, ctx);
    expect(res.ok).toBe(true);
    expect(res.output).toContain('treat the result as PARTIAL');
  });

  it('summarizes calls compactly', () => {
    const { ctx } = tmpCtx();
    const tool = createAgentTool(() => deps(new ScriptedProvider([]), ctx.cwd));
    expect(tool.summarize({ agent_type: 'explore', prompt: 'find the thing' }, ctx)).toBe(
      'explore: find the thing',
    );
  });
});
