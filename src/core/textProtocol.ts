import type { ToolCall } from '../providers/types.js';

export interface TextExtraction {
  /** Extracted call, if a well-formed block (or bare-JSON call) was found. */
  call?: ToolCall;
  /** A block was attempted but is unparseable — feed a format reminder back. */
  malformed?: string;
  /** True when more than one block was present (only the first is executed). */
  extra: boolean;
}

const BLOCK_RE = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
const OPEN_TAG = '<tool_call>';

/**
 * Extract a tool call from a text-protocol response. Lenient by design —
 * accepts fenced JSON inside the tags, "parameters" as an alias for
 * "arguments", an unclosed trailing block, and (last resort) a bare JSON
 * object that looks like a tool call, which is exactly what small models
 * emit when they hallucinate the format.
 */
export function extractTextToolCall(content: string, idSeed: number): TextExtraction {
  const blocks = [...content.matchAll(BLOCK_RE)];
  if (blocks.length > 0) {
    const parsed = parseCallJson(blocks[0][1], idSeed);
    if (!parsed) return { malformed: blocks[0][1], extra: blocks.length > 1 };
    return { call: parsed, extra: blocks.length > 1 };
  }

  // Unclosed trailing block: "<tool_call>{...}" at the end of the output.
  const openIdx = content.lastIndexOf(OPEN_TAG);
  if (openIdx !== -1 && !content.slice(openIdx).includes('</tool_call>')) {
    const body = content.slice(openIdx + OPEN_TAG.length).trim();
    const parsed = parseCallJson(body, idSeed);
    if (parsed) return { call: parsed, extra: false };
    return { malformed: body, extra: false };
  }

  // Bare JSON heuristic: a lone {"name": ..., "arguments"/"parameters": ...}
  // line — no tags at all.
  const bare = content.match(/^\s*(\{[\s\S]*\})\s*$/m);
  if (bare) {
    const parsed = parseCallJson(bare[1], idSeed);
    if (parsed) return { call: parsed, extra: false };
  }
  return { extra: false };
}

function parseCallJson(raw: string, idSeed: number): ToolCall | undefined {
  let s = raw.trim();
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) s = fence[1].trim();
  let obj: unknown;
  try {
    obj = JSON.parse(s);
  } catch {
    return undefined;
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return undefined;
  const rec = obj as Record<string, unknown>;
  const name = rec.name ?? rec.tool ?? rec.tool_name;
  if (typeof name !== 'string' || !name) return undefined;
  const args = rec.arguments ?? rec.parameters ?? rec.args ?? {};
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return undefined;
  return { id: `text_${idSeed}`, name, arguments: JSON.stringify(args) };
}

/** Wrap a tool result for delivery in a user message (no native tool role). */
export function formatTextToolResult(name: string, output: string): string {
  return `<tool_result name="${name}">\n${output}\n</tool_result>`;
}

/** Format reminder injected after a malformed tool-call attempt. */
export const FORMAT_REMINDER = [
  'Your tool call could not be parsed. Use EXACTLY this format — one block, valid JSON, nothing after the closing tag:',
  '',
  '<tool_call>',
  '{"name": "Read", "arguments": {"file_path": "path/to/file"}}',
  '</tool_call>',
  '',
  'If you are finished with the task, answer normally without any <tool_call> block.',
].join('\n');
