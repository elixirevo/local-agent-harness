import { describe, expect, it } from 'vitest';
import {
  budgetStatus,
  DEFAULT_COMPACTION,
  estimateContextTokens,
  estimateTokens,
} from '../src/context/budget.js';
import { clearOldToolResults, CLEARED_NOTE } from '../src/context/frc.js';
import type { ChatMessage } from '../src/providers/types.js';

describe('token estimation', () => {
  it('overestimates typical English/code (safety direction)', () => {
    const text = 'function add(a, b) { return a + b; } // typical code density';
    // real tokenizers land near chars/4; our chars/3.3 must be higher
    expect(estimateTokens(text)).toBeGreaterThan(text.length / 4);
  });

  it('counts tool calls and message overhead', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'Read', arguments: '{"file_path":"a.ts"}' }],
      },
    ];
    const withCall = estimateContextTokens(messages);
    const withoutCall = estimateContextTokens([messages[0], { role: 'assistant', content: '' }]);
    expect(withCall).toBeGreaterThan(withoutCall);
  });

  it('adapts the output reserve to small windows', () => {
    // reserve = min(2048, ctx/4): 2048 would swallow the whole 2k window
    expect(budgetStatus([], 2048, DEFAULT_COMPACTION).usableTokens).toBe(2048 - 512);
    expect(budgetStatus([], 32768, DEFAULT_COMPACTION).usableTokens).toBe(32768 - 2048);
  });
});

describe('clearOldToolResults', () => {
  const big = 'x'.repeat(1000);
  const toolMsg = (content: string): ChatMessage => ({ role: 'tool', content, toolCallId: 'c' });
  const textResult = (content: string): ChatMessage => ({
    role: 'user',
    content: `<tool_result name="Read">\n${content}\n</tool_result>`,
  });

  it('clears old large results, keeps the most recent N, never mutates originals', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'go' },
      toolMsg(big),
      toolMsg(big),
      toolMsg(big),
    ];
    const res = clearOldToolResults(messages, 2);
    expect(res.cleared).toBe(1);
    expect(res.messages[1].content).toBe(CLEARED_NOTE);
    expect(res.messages[2].content).toBe(big);
    expect(res.messages[3].content).toBe(big);
    expect(messages[1].content).toBe(big); // original untouched
    expect(res.freedChars).toBeGreaterThan(900);
  });

  it('handles text-protocol results, keeping the block shape and tool name', () => {
    const messages: ChatMessage[] = [textResult(big), textResult(big), { role: 'user', content: 'q' }];
    const res = clearOldToolResults(messages, 1);
    expect(res.cleared).toBe(1);
    expect(res.messages[0].content).toBe(`<tool_result name="Read">\n${CLEARED_NOTE}\n</tool_result>`);
    expect(res.messages[1].content).toContain(big);
    expect(res.messages[2].content).toBe('q'); // real user message untouched
  });

  it('skips small results and already-cleared stubs', () => {
    const messages: ChatMessage[] = [
      toolMsg('tiny'),
      toolMsg(CLEARED_NOTE),
      toolMsg(big),
      toolMsg(big),
    ];
    const res = clearOldToolResults(messages, 0);
    expect(res.cleared).toBe(2); // only the two big live results
    expect(res.messages[0].content).toBe('tiny');
    expect(res.messages[1].content).toBe(CLEARED_NOTE);
  });
});
