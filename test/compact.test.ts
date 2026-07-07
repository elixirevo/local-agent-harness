import { describe, expect, it } from 'vitest';
import { compactSession } from '../src/compact/compact.js';
import { countSections } from '../src/compact/prompt.js';
import type {
  ChatChunk,
  ChatMessage,
  ChatRequest,
  ProviderAdapter,
  ProviderCaps,
} from '../src/providers/types.js';

const VALID_SUMMARY = [
  '## 1. Task and intent\nFix the add bug.',
  '## 2. Files and code\nsrc/calc.js line 2.',
  '## 3. What was tried\nRead the file.',
  '## 4. User feedback\nnone',
  '## 5. Current state\nEditing calc.js.',
  '## 6. Next step\n"fix the add function" — run Edit.',
].join('\n\n');

class SummaryProvider implements ProviderAdapter {
  readonly name = 'summary';
  readonly requests: ChatRequest[] = [];
  private responses: string[];

  constructor(responses: string[]) {
    this.responses = responses;
  }

  async *chat(req: ChatRequest): AsyncIterable<ChatChunk> {
    this.requests.push({ ...req, messages: JSON.parse(JSON.stringify(req.messages)) });
    const text = this.responses.shift() ?? VALID_SUMMARY;
    yield { type: 'text', text };
    yield { type: 'done', stopReason: 'stop' };
  }

  capabilities(): ProviderCaps {
    return { nativeToolCalls: false, grammar: false, tokenCount: false, reportsCacheHits: false };
  }

  async listModels(): Promise<string[]> {
    return [];
  }
}

const opts = (provider: ProviderAdapter) => ({
  provider,
  model: 'm',
  contextLength: 4096,
  thinking: 'none' as const,
  think: undefined,
  transcriptPath: '/tmp/session.jsonl',
});

const filler = (n: number): ChatMessage[] =>
  Array.from({ length: n }, (_, i): ChatMessage =>
    i % 2 === 0
      ? { role: 'user', content: `question ${i} ${'x'.repeat(300)}` }
      : { role: 'assistant', content: `answer ${i} ${'y'.repeat(300)}` },
  );

describe('countSections', () => {
  it('counts the numbered headings', () => {
    expect(countSections(VALID_SUMMARY)).toBe(6);
    expect(countSections('## 1. only this')).toBe(1);
    expect(countSections('no headings')).toBe(0);
  });
});

describe('compactSession', () => {
  it('summarizes without tools and rebuilds around a verbatim user tail', async () => {
    const provider = new SummaryProvider([VALID_SUMMARY]);
    const history: ChatMessage[] = [
      { role: 'system', content: 'SYS' },
      ...filler(10),
      { role: 'user', content: 'latest question' },
    ];
    const result = await compactSession(history, opts(provider));

    // summarize request: no tools param, compact prompt last
    const req = provider.requests[0];
    expect(req.tools).toBeUndefined();
    expect(req.messages.at(-1)?.content).toContain('CRITICAL: Respond with TEXT ONLY');
    expect(req.temperature).toBe(0.2);

    // rebuilt: [system, merged user(summary + latest question)]
    expect(result.messages[0].content).toBe('SYS');
    const merged = result.messages[1];
    expect(merged.role).toBe('user');
    expect(merged.content).toContain('# Conversation summary');
    expect(merged.content).toContain('Read files again before editing');
    expect(merged.content).toContain('/tmp/session.jsonl');
    expect(merged.content).toContain('latest question');
    expect(result.messages).toHaveLength(2);
    expect(result.afterTokens).toBeLessThan(result.beforeTokens);
    expect(result.degraded).toBe(false);
  });

  it('keeps a trailing assistant+tool exchange intact (mid-turn compaction)', async () => {
    const provider = new SummaryProvider([VALID_SUMMARY]);
    const history: ChatMessage[] = [
      { role: 'system', content: 'SYS' },
      ...filler(30), // big enough that the last real user turn exceeds the tail cap
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c9', name: 'Read', arguments: '{"file_path":"a.ts"}' }],
      },
      { role: 'tool', content: 'file body', toolCallId: 'c9' },
    ];
    const result = await compactSession(history, { ...opts(provider), contextLength: 600 });

    const roles = result.messages.map((m) => m.role);
    expect(roles).toEqual(['system', 'user', 'assistant', 'tool']);
    expect(result.messages[1].content).toContain('# Conversation summary');
    expect(result.messages[2].toolCalls?.[0].id).toBe('c9'); // pair preserved
    expect(result.messages[3].content).toBe('file body');
  });

  it('pins the first user message verbatim, minus reminder blocks', async () => {
    const provider = new SummaryProvider([VALID_SUMMARY]);
    const history: ChatMessage[] = [
      { role: 'system', content: 'SYS' },
      {
        role: 'user',
        content: '<system-reminder>\nstartup context noise\n</system-reminder>\n\nRemember the codeword BLUEFROG-77 and fix the bug.',
      },
      ...filler(10),
      { role: 'user', content: 'latest' },
    ];
    const result = await compactSession(history, opts(provider));
    const merged = result.messages[1].content;
    expect(merged).toContain("The user's first message this session (verbatim)");
    expect(merged).toContain('Remember the codeword BLUEFROG-77');
    expect(merged).not.toContain('startup context noise');
  });

  it('retries once when the summary misses the section contract', async () => {
    const provider = new SummaryProvider(['whatever, no sections', VALID_SUMMARY]);
    const history: ChatMessage[] = [
      { role: 'system', content: 'SYS' },
      ...filler(8),
      { role: 'user', content: 'latest' },
    ];
    const result = await compactSession(history, opts(provider));
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1].messages.at(-1)?.content).toContain('did not contain the six');
    expect(result.degraded).toBe(false);
    expect(result.messages[1].content).toContain('## 1.');
  });

  it('degrades gracefully when both attempts fail validation', async () => {
    const provider = new SummaryProvider(['junk', 'still junk ## 1. only']);
    const history: ChatMessage[] = [{ role: 'system', content: 'SYS' }, ...filler(8), { role: 'user', content: 'q' }];
    const result = await compactSession(history, opts(provider));
    expect(result.degraded).toBe(true);
    expect(result.messages[1].content).toContain('## 1. only'); // best of the two
  });

  it('is a no-op when there is nothing before the tail', async () => {
    const provider = new SummaryProvider([]);
    const history: ChatMessage[] = [
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'first question' },
    ];
    const result = await compactSession(history, opts(provider));
    expect(provider.requests).toHaveLength(0);
    expect(result.messages).toBe(history);
  });
});
