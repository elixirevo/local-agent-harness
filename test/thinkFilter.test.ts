import { describe, expect, it } from 'vitest';
import { ThinkTagStream, type ThinkEvent } from '../src/util/thinkFilter.js';

function run(deltas: string[]): { thinking: string; text: string } {
  const s = new ThinkTagStream();
  const events: ThinkEvent[] = [];
  for (const d of deltas) events.push(...s.push(d));
  events.push(...s.flush());
  return {
    thinking: events.filter((e) => e.type === 'thinking').map((e) => e.text).join(''),
    text: events.filter((e) => e.type === 'text').map((e) => e.text).join(''),
  };
}

describe('ThinkTagStream', () => {
  it('passes plain text through untouched', () => {
    expect(run(['Hello', ' world'])).toEqual({ thinking: '', text: 'Hello world' });
  });

  it('splits a leading think block from the answer', () => {
    expect(run(['<think>reasoning here</think>\n\nAnswer'])).toEqual({
      thinking: 'reasoning here',
      text: 'Answer',
    });
  });

  it('handles tags split across every chunk boundary', () => {
    const full = '<think>abc</think>\n\nHello!';
    for (const size of [1, 2, 3, 5]) {
      const deltas: string[] = [];
      for (let i = 0; i < full.length; i += size) deltas.push(full.slice(i, i + size));
      expect(run(deltas)).toEqual({ thinking: 'abc', text: 'Hello!' });
    }
  });

  it('tolerates whitespace before the opening tag', () => {
    expect(run(['\n <think>x</think>y'])).toEqual({ thinking: 'x', text: 'y' });
  });

  it('handles an empty think block', () => {
    expect(run(['<think>', '</think>', '\n\nAnswer'])).toEqual({ thinking: '', text: 'Answer' });
  });

  it('treats an unclosed block as thinking at flush', () => {
    expect(run(['<think>never closed'])).toEqual({ thinking: 'never closed', text: '' });
  });

  it('emits a lone partial open tag as text at flush', () => {
    expect(run(['<thin'])).toEqual({ thinking: '', text: '<thin' });
  });

  it('does not treat a mid-response tag as thinking', () => {
    expect(run(['The tag <think> is literal'])).toEqual({
      thinking: '',
      text: 'The tag <think> is literal',
    });
  });

  it('preserves text that merely starts with an angle bracket', () => {
    expect(run(['<div>markup</div>'])).toEqual({ thinking: '', text: '<div>markup</div>' });
  });
});
