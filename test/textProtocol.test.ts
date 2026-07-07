import { describe, expect, it } from 'vitest';
import { extractTextToolCall, formatTextToolResult } from '../src/core/textProtocol.js';

describe('extractTextToolCall', () => {
  it('extracts a well-formed block with surrounding prose', () => {
    const ex = extractTextToolCall(
      'Let me read it.\n<tool_call>\n{"name": "Read", "arguments": {"file_path": "a.ts"}}\n</tool_call>',
      0,
    );
    expect(ex.call).toEqual({ id: 'text_0', name: 'Read', arguments: '{"file_path":"a.ts"}' });
    expect(ex.extra).toBe(false);
  });

  it('accepts fenced JSON and the parameters/tool aliases', () => {
    const fenced = extractTextToolCall(
      '<tool_call>\n```json\n{"tool": "Grep", "parameters": {"pattern": "x"}}\n```\n</tool_call>',
      1,
    );
    expect(fenced.call?.name).toBe('Grep');
    expect(JSON.parse(fenced.call!.arguments)).toEqual({ pattern: 'x' });
  });

  it('recovers an unclosed trailing block', () => {
    const ex = extractTextToolCall('<tool_call>\n{"name": "Glob", "arguments": {"pattern": "*.ts"}}', 2);
    expect(ex.call?.name).toBe('Glob');
  });

  it('recovers a bare JSON call without tags (the llama3.2 failure mode)', () => {
    const ex = extractTextToolCall('{"name": "Read", "parameters": {"file_path": "src/calc.js"}}', 3);
    expect(ex.call?.name).toBe('Read');
    expect(JSON.parse(ex.call!.arguments)).toEqual({ file_path: 'src/calc.js' });
  });

  it('flags malformed JSON inside tags', () => {
    const ex = extractTextToolCall('<tool_call>\n{oops not json}\n</tool_call>', 4);
    expect(ex.call).toBeUndefined();
    expect(ex.malformed).toContain('oops');
  });

  it('takes the first of multiple blocks and marks extra', () => {
    const ex = extractTextToolCall(
      '<tool_call>{"name": "Read", "arguments": {"file_path": "a"}}</tool_call>\n' +
        '<tool_call>{"name": "Read", "arguments": {"file_path": "b"}}</tool_call>',
      5,
    );
    expect(JSON.parse(ex.call!.arguments).file_path).toBe('a');
    expect(ex.extra).toBe(true);
  });

  it('returns nothing for plain prose, even with JSON-ish fragments', () => {
    expect(extractTextToolCall('The answer is 42.', 6).call).toBeUndefined();
    expect(extractTextToolCall('Config example: {"a": 1} works.', 7).call).toBeUndefined();
  });

  it('ignores empty argument objects gracefully', () => {
    const ex = extractTextToolCall('<tool_call>{"name": "Glob", "arguments": {}}</tool_call>', 8);
    expect(ex.call?.arguments).toBe('{}');
  });
});

describe('formatTextToolResult', () => {
  it('wraps output in a named result block', () => {
    expect(formatTextToolResult('Read', 'content')).toBe('<tool_result name="Read">\ncontent\n</tool_result>');
  });
});
