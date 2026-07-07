import type { ChatMessage } from '../providers/types.js';

export const CLEARED_NOTE = '(tool result cleared to save context — re-run the tool if you need it again)';
const TEXT_RESULT_PREFIX = '<tool_result name="';
/** Results smaller than this stay — clearing them frees nothing meaningful. */
const MIN_CLEAR_CHARS = 200;

export interface FrcResult {
  messages: ChatMessage[];
  cleared: number;
  freedChars: number;
}

/**
 * Function-result clearing: replace old, large tool results with a stub,
 * keeping the most recent `keepRecent` intact. The cheap tier of context
 * reclamation — used before resorting to full compaction.
 *
 * Returns a NEW array with new objects for changed entries (history objects
 * are never mutated — turn rollback holds references into the old array).
 * Rewriting old messages knowingly invalidates the server prefix cache once;
 * that is the price of the freed context.
 */
export function clearOldToolResults(messages: ChatMessage[], keepRecent: number): FrcResult {
  const resultIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (isClearableResult(messages[i])) resultIndices.push(i);
  }
  const clearable = new Set(resultIndices.slice(0, Math.max(0, resultIndices.length - keepRecent)));

  let cleared = 0;
  let freedChars = 0;
  const out = messages.map((m, i) => {
    if (!clearable.has(i)) return m;
    const replacement = stubFor(m);
    if (replacement.content.length >= m.content.length) return m;
    cleared++;
    freedChars += m.content.length - replacement.content.length;
    return replacement;
  });
  return { messages: out, cleared, freedChars };
}

function isClearableResult(m: ChatMessage): boolean {
  if (m.content.includes(CLEARED_NOTE)) return false;
  if (m.content.length < MIN_CLEAR_CHARS) return false;
  if (m.role === 'tool') return true;
  // Text-protocol results are user messages wrapping a single result block.
  return m.role === 'user' && m.content.startsWith(TEXT_RESULT_PREFIX);
}

function stubFor(m: ChatMessage): ChatMessage {
  if (m.role === 'tool') {
    return { ...m, content: CLEARED_NOTE };
  }
  // Keep the block shape (and tool name) so the model still sees what ran.
  const nameEnd = m.content.indexOf('"', TEXT_RESULT_PREFIX.length);
  const name = nameEnd === -1 ? '?' : m.content.slice(TEXT_RESULT_PREFIX.length, nameEnd);
  return { ...m, content: `<tool_result name="${name}">\n${CLEARED_NOTE}\n</tool_result>` };
}
