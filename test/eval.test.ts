import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/config.js';
import type {
  ChatChunk,
  ChatRequest,
  ProviderAdapter,
  ProviderCaps,
  ToolCall,
} from '../src/providers/types.js';
import { buildConfigMatrix, formatReport } from '../src/eval/report.js';
import { runScenario, type EvalConfig } from '../src/eval/runner.js';
import { selectScenarios, SCENARIOS } from '../src/eval/scenarios.js';

class ScriptedProvider implements ProviderAdapter {
  readonly name = 'scripted';
  constructor(private steps: ChatChunk[][]) {}
  async *chat(_req: ChatRequest): AsyncIterable<ChatChunk> {
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

const cfg: EvalConfig = { model: 'scripted-tools', tier: 'minimal', protocol: 'native' };

function harnessConfig() {
  const config = loadConfig('/nonexistent');
  config.models = { 'scripted-tools': { nativeToolCalls: true } };
  return config;
}

describe('scenario suite', () => {
  it('has unique ids and covers the planned kinds', () => {
    const ids = SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const kind of ['edit', 'debug', 'multistep', 'search', 'agent']) {
      expect(SCENARIOS.some((s) => s.kind === kind)).toBe(true);
    }
  });

  it('builds skill A/B variants from the shipped skill files', () => {
    const testFix = SCENARIOS.find((s) => s.id === 'skill-test-fix')!;
    expect(testFix.turns[0]).toContain('Follow this workflow step by step:');
    expect(testFix.turns[0]).toContain('node test.js'); // $ARGUMENTS substituted
    const findChange = SCENARIOS.find((s) => s.id === 'skill-find-change')!;
    expect(findChange.turns[0]).toContain('DEFINED (not just used)');
    expect(findChange.turns[0]).toContain('change MAX_RETRIES from 3 to 5');
  });

  it('filters by id and by heaviness', () => {
    expect(selectScenarios(undefined, false).every((s) => !s.heavy)).toBe(true);
    expect(selectScenarios(undefined, true).length).toBeGreaterThan(selectScenarios(undefined, false).length);
    expect(selectScenarios(['edit-fix-operator'], false)).toHaveLength(1);
    expect(() => selectScenarios(['nope'], false)).toThrow(/unknown scenario/);
  });
});

describe('runScenario', () => {
  it('runs a loop scenario end-to-end and judges success programmatically', async () => {
    // edit-fix-operator: model reads then edits the file correctly.
    const provider = new ScriptedProvider([
      toolStep(call('Read', { file_path: 'src/calc.js' })),
      toolStep(call('Edit', { file_path: 'src/calc.js', old_string: 'return a - b;', new_string: 'return a + b;' })),
      textStep('Fixed the operator.'),
    ]);
    const scenario = SCENARIOS.find((s) => s.id === 'edit-fix-operator')!;
    const result = await runScenario(scenario, cfg, provider, harnessConfig());
    expect(result.success).toBe(true);
    expect(result.steps).toBe(3);
    expect(result.toolCalls).toBe(2);
    expect(result.toolErrors).toBe(0);
    expect(result.detail).toBe('tests pass');
  });

  it('marks failure when the model claims success without fixing anything', async () => {
    const provider = new ScriptedProvider([textStep('I fixed it! (no, it did not)')]);
    const scenario = SCENARIOS.find((s) => s.id === 'edit-fix-operator')!;
    const result = await runScenario(scenario, cfg, provider, harnessConfig());
    expect(result.success).toBe(false);
    expect(result.detail).toContain('tests fail');
  });

  it('counts tool errors and guard stops', async () => {
    const bad = () => toolStep(call('Read', { file_path: 'nope.js' }));
    const provider = new ScriptedProvider([bad(), bad(), bad(), bad(), textStep('gave up')]);
    const scenario = SCENARIOS.find((s) => s.id === 'edit-fix-operator')!;
    const result = await runScenario(scenario, cfg, provider, harnessConfig());
    expect(result.success).toBe(false);
    expect(result.toolErrors).toBeGreaterThan(0);
    expect(result.guardStops).toBe(1); // repeats tripped the guard
  });

  it('runs subagent scenarios directly', async () => {
    const provider = new ScriptedProvider([
      textStep('Scope: search\nResult: src/deep/helpers.js defines formatPrice\nKey files: src/deep/helpers.js'),
    ]);
    const scenario = SCENARIOS.find((s) => s.id === 'explore-find-definition')!;
    const result = await runScenario(scenario, cfg, provider, harnessConfig());
    expect(result.success).toBe(true);
    expect(result.detail).toBe('file identified');
  });
});

describe('report', () => {
  it('builds the config matrix as a cartesian product', () => {
    const matrix = buildConfigMatrix({
      models: ['a', 'b'],
      tiers: ['minimal'],
      protocols: ['native', 'text'],
      temps: ['profile', '0.4'],
    });
    expect(matrix).toHaveLength(8);
    expect(matrix.some((c) => c.temperature === 0.4)).toBe(true);
    expect(matrix.some((c) => c.temperature === undefined)).toBe(true);
  });

  it('formats per-cell tables with totals and a matrix summary', () => {
    const base = {
      scenarioId: 'edit-fix-operator',
      success: true,
      detail: 'tests pass',
      steps: 3,
      toolCalls: 2,
      toolErrors: 0,
      parseFailures: 0,
      guardStops: 0,
      compactions: 0,
      frcClears: 0,
      genTokens: 100,
      prefillMsTotal: 50,
      promptTokensMax: 1000,
      wallMs: 5000,
      timedOut: false,
      answer: 'done',
    };
    const text = formatReport({
      startedAt: 'now',
      results: [
        { ...base, config: { model: 'm1', tier: 'minimal', protocol: 'native' } },
        { ...base, success: false, detail: 'tests fail', config: { model: 'm2', tier: 'minimal', protocol: 'text' } },
      ],
    });
    expect(text).toContain('=== m1 · minimal · native · temp profile ===');
    expect(text).toContain('TOTAL 1/1');
    expect(text).toContain('=== matrix summary ===');
    expect(text).toContain('0/1 (0%)');
  });
});
