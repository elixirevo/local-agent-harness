import type { ChatMessage, ToolDef } from '../providers/types.js';

/**
 * Conservative token estimation. Tokenizers differ per model and Ollama's
 * usage reporting is unreliable as a "total context" signal (semantics vary
 * by engine — see providers/ollama.ts), so budgeting is self-computed from
 * characters with a safety margin: ~3.3 chars/token overestimates for
 * English/code (real ratio ≈ 4), i.e. errs toward compacting early. CJK text
 * runs closer to 1 token/char, which this underestimates — acceptable while
 * tool output (code, logs) dominates agent contexts.
 */
const CHARS_PER_TOKEN = 3.3;
const PER_MESSAGE_OVERHEAD = 5;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function estimateMessageTokens(message: ChatMessage): number {
  let chars = message.content.length;
  if (message.toolCalls) {
    for (const call of message.toolCalls) chars += call.name.length + call.arguments.length + 20;
  }
  return Math.ceil(chars / CHARS_PER_TOKEN) + PER_MESSAGE_OVERHEAD;
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
