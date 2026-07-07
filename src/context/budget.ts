import type { ChatMessage, ToolDef } from '../providers/types.js';

/**
 * Token estimation by character class. Measured against real tokenizers
 * (Ollama prompt_eval_count, slope method to cancel template overhead,
 * 2026-07-07 — see the eval notes):
 *
 *   chars/token        gemma4:e2b   llama3.2
 *   code                  3.25        4.19
 *   English prose         6.53        6.32
 *   Korean                1.59        1.52
 *   tool output (cat -n)  2.45        3.38
 *
 * A single divisor cannot be safe for that spread — a uniform 3.3 was 2×
 * UNDER for Korean (overflow risk, the dangerous direction) while 2× over
 * for prose (needless early compaction). Splitting by character class gets
 * both within tolerable bounds: ASCII at 3.0 (slightly conservative for
 * code/tool output, generous for prose), non-ASCII at 1.6 (CJK-calibrated).
 * The compaction threshold's 25% headroom absorbs the residual error.
 */
const ASCII_CHARS_PER_TOKEN = 3.0;
const NON_ASCII_CHARS_PER_TOKEN = 1.6;
const PER_MESSAGE_OVERHEAD = 5;

export function estimateTokens(text: string): number {
  let nonAscii = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) nonAscii++;
  }
  const ascii = text.length - nonAscii;
  return Math.ceil(ascii / ASCII_CHARS_PER_TOKEN + nonAscii / NON_ASCII_CHARS_PER_TOKEN);
}

export function estimateMessageTokens(message: ChatMessage): number {
  let total = estimateTokens(message.content);
  if (message.toolCalls) {
    for (const call of message.toolCalls) total += estimateTokens(call.name + call.arguments) + 6;
  }
  return total + PER_MESSAGE_OVERHEAD;
}

export function estimateContextTokens(messages: ChatMessage[], toolDefs?: ToolDef[]): number {
  let total = 0;
  for (const m of messages) total += estimateMessageTokens(m);
  if (toolDefs) total += estimateTokens(JSON.stringify(toolDefs));
  return total;
}

export interface CompactionSettings {
  enabled: boolean;
  /** Compact when estimate exceeds this fraction of the usable budget. */
  threshold: number;
  /** Try clearing old tool results first at this (lower) fraction. */
  frcThreshold: number;
  /** Tool results to keep verbatim when clearing. */
  keepRecentResults: number;
  /** Head-room reserved for the model's output. */
  reserveTokens: number;
}

export const DEFAULT_COMPACTION: CompactionSettings = {
  enabled: true,
  threshold: 0.75,
  frcThreshold: 0.6,
  keepRecentResults: 5,
  reserveTokens: 2048,
};

export interface BudgetStatus {
  estimatedTokens: number;
  /** contextLength minus the output reserve. */
  usableTokens: number;
  /** estimatedTokens / usableTokens (can exceed 1). */
  usage: number;
}

export function budgetStatus(
  messages: ChatMessage[],
  contextLength: number,
  settings: CompactionSettings,
  toolDefs?: ToolDef[],
): BudgetStatus {
  const estimatedTokens = estimateContextTokens(messages, toolDefs);
  // The output reserve adapts to small windows (a fixed 2048 would swallow an
  // 8k-class context), and the conversation always keeps at least half.
  const reserve = Math.min(settings.reserveTokens, Math.floor(contextLength / 4));
  const usableTokens = Math.max(contextLength - reserve, Math.floor(contextLength / 2));
  return { estimatedTokens, usableTokens, usage: estimatedTokens / usableTokens };
}
