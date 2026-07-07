import { describe, expect, it } from 'vitest';
import { compactSession } from '../src/compact/compact.js';
import { renderJsonSummary } from '../src/compact/prompt.js';
import type {
  ChatChunk,
  ChatMessage,
  ChatRequest,
  ProviderAdapter,
  ProviderCaps,
} from '../src/providers/types.js';

describe('grammar-enforced compact retry', () => {
  const JSON_SUMMARY = JSON.stringify({
    task_and_intent: 'fix the bug',
    files_and_code: 'src/calc.js',
    what_was_tried: 'read it',
    user_feedback: 'none',
    current_state: 'editing',
    next_step: 'run tests',
  });

  class GrammarProvider implements ProviderAdapter {
    readonly name = 'grammar';
    readonly requests: ChatRequest[] = [];
    constructor(private responses: string[]) {}
    async *chat(req: ChatRequest): AsyncIterable<ChatChunk> {
      this.requests.push(req);
      yield { type: 'text', text: this.responses.shift() ?? '' };
      yield { type: 'done', stopReason: 'stop' };
    }
    capabilities(): ProviderCaps {
      return { nativeToolCalls: false, grammar: true, tokenCount: false, reportsCacheHits: false };
    }
    async listModels(): Promise<string[]> {
      return [];
    }
  }

  const history = (): ChatMessage[] => [
    { role: 'system', content: 'SYS' },
    ...Array.from({ length: 8 }, (_, i): ChatMessage =>
      i % 2 === 0
        ? { role: 'user', content: `q${i} ${'x'.repeat(200)}` }
        : { role: 'assistant', content: `a${i} ${'y'.repeat(200)}` },
    ),
    { role: 'user', content: 'latest' },
  ];

  it('retries with the JSON schema and renders the six sections', async () => {
    const provider = new GrammarProvider(['no sections at all', JSON_SUMMARY]);
    const result = await compactSession(history(), {
      provider,
      model: 'm',
      contextLength: 4096,
      thinking: 'none',
      think: undefined,
    });
    expect(result.degraded).toBe(false);
    expect(provider.requests[1].format).toBeDefined();
    expect(provider.requests[1].format?.required).toContain('next_step');
    expect(result.messages[1].content).toContain('## 1. Task and intent\nfix the bug');
    expect(result.messages[1].content).toContain('## 6. Next step\nrun tests');
  });

  it('falls back to the plain retry when the JSON is unusable', async () => {
    const provider = new GrammarProvider(['junk', 'not json either', '## 1. a\n## 2. b\n## 3. c\n## 4. d\n## 5. e\n## 6. f']);
    const result = await compactSession(history(), {
      provider,
      model: 'm',
      contextLength: 4096,
      thinking: 'none',
      think: undefined,
    });
    expect(provider.requests).toHaveLength(3); // plain, schema'd, plain retry
    expect(result.degraded).toBe(false);
  });
});

describe('renderJsonSummary', () => {
  it('renders all six titles and fills gaps with (none)', () => {
    const rendered = renderJsonSummary(
      JSON.stringify({ task_and_intent: 't', files_and_code: '', what_was_tried: 'w', user_feedback: 'u', current_state: 'c', next_step: 'n' }),
    )!;
    expect(rendered).toContain('## 2. Files and code\n(none)');
    expect(rendered.match(/^## \d\./gm)).toHaveLength(6);
    expect(renderJsonSummary('not json')).toBeUndefined();
    expect(renderJsonSummary('[1]')).toBeUndefined();
  });
});
