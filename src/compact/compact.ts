import { systemReminder } from '../context/reminders.js';
import { estimateContextTokens, estimateMessageTokens } from '../context/budget.js';
import type { ChatMessage, ProviderAdapter, ThinkingMode } from '../providers/types.js';
import {
  COMPACT_PROMPT,
  COMPACT_RETRY_SUFFIX,
  continuationBlock,
  countSections,
  renderJsonSummary,
  SUMMARY_JSON_SUFFIX,
  SUMMARY_SCHEMA,
} from './prompt.js';

export interface CompactOptions {
  provider: ProviderAdapter;
  model: string;
  contextLength: number;
  thinking: ThinkingMode;
  think: boolean | undefined;
  transcriptPath?: string;
  signal?: AbortSignal;
}

export interface CompactResult {
  messages: ChatMessage[];
  summary: string;
  /** True when the summary failed heading validation even after the retry. */
  degraded: boolean;
  beforeTokens: number;
  afterTokens: number;
}

const MIN_ACCEPT_SECTIONS = 4;

/**
 * Compact a conversation: summarize everything except a verbatim tail, then
 * rebuild [system, continuation+summary, ...tail]. The summarization request
 * carries no tools; see prompt.ts for the double no-tools defense.
 */
export async function compactSession(
  messages: ChatMessage[],
  opts: CompactOptions,
): Promise<CompactResult> {
  const beforeTokens = estimateContextTokens(messages);
  const system = messages[0]?.role === 'system' ? messages[0] : undefined;
  const body = system ? messages.slice(1) : messages;

  // Nothing worth folding: a summary of less than one exchange only loses
  // information (and re-summarizing a fresh summary would thrash forever).
  if (body.length < 3) {
    return { messages, summary: '', degraded: false, beforeTokens, afterTokens: beforeTokens };
  }

  const tailStart = pickTailStart(body, opts.contextLength);
  const toSummarize = body.slice(0, tailStart);
  const tail = body.slice(tailStart);
  if (toSummarize.length === 0) {
    return { messages, summary: '', degraded: false, beforeTokens, afterTokens: beforeTokens };
  }

  const { summary, degraded } = await summarize(system, toSummarize, opts);

  // Pin the session's opening request verbatim: goals and instructions given
  // in the first message are exactly what chained lossy summaries erode.
  const firstUser = body.find((m) => m.role === 'user' && !m.content.startsWith('<tool_result'));
  const firstUserQuote = firstUser ? stripReminders(firstUser.content).slice(0, 600) : '';
  const pinned = firstUserQuote
    ? `\n\n# The user's first message this session (verbatim)\n\n${firstUserQuote}`
    : '';

  const block = `${systemReminder(continuationBlock(opts.transcriptPath))}${pinned}\n\n# Conversation summary\n\n${summary}`;
  const rebuilt: ChatMessage[] = [];
  if (system) rebuilt.push(system);
  if (tail.length > 0 && tail[0].role === 'user') {
    // Merge into the tail's first user message — avoids consecutive user
    // messages, mirroring how reminders attach.
    rebuilt.push({ ...tail[0], content: `${block}\n\n${tail[0].content}` }, ...tail.slice(1));
  } else {
    rebuilt.push({ role: 'user', content: block }, ...tail);
  }

  return {
    messages: rebuilt,
    summary,
    degraded,
    beforeTokens,
    afterTokens: estimateContextTokens(rebuilt),
  };
}

/**
 * Choose where the verbatim tail begins. Preference order:
 * 1. the last real user turn (best recency) if it fits in ~30% of the window,
 * 2. the last assistant step with its tool results (the model needs those to
 *    continue mid-task) if it fits in ~40%,
 * 3. no tail — everything is summarized.
 * Cutting at a user turn or at an assistant message never strands a tool
 * result from its call.
 */
function pickTailStart(body: ChatMessage[], contextLength: number): number {
  const lastUser = findLast(body, (m) => m.role === 'user' && !m.content.startsWith('<tool_result'));
  if (lastUser >= 0 && sliceTokens(body, lastUser) <= contextLength * 0.3) return lastUser;

  const lastAssistant = findLast(body, (m) => m.role === 'assistant');
  if (lastAssistant >= 0 && sliceTokens(body, lastAssistant) <= contextLength * 0.4) return lastAssistant;

  return body.length;
}

function stripReminders(content: string): string {
  return content.replace(/<system-reminder>[\s\S]*?<\/system-reminder>\s*/g, '').trim();
}

function findLast(body: ChatMessage[], pred: (m: ChatMessage) => boolean): number {
  for (let i = body.length - 1; i >= 0; i--) {
    if (pred(body[i])) return i;
  }
  return -1;
}

function sliceTokens(body: ChatMessage[], from: number): number {
  let total = 0;
  for (let i = from; i < body.length; i++) total += estimateMessageTokens(body[i]);
  return total;
}

async function summarize(
  system: ChatMessage | undefined,
  toSummarize: ChatMessage[],
  opts: CompactOptions,
): Promise<{ summary: string; degraded: boolean }> {
  // The summarize request itself must fit the physical window — inference
  // servers truncate the HEAD silently on overflow, which would eat the
  // system prompt and early task context. Drop the oldest messages first;
  // the tail and recency sections still anchor the continuation.
  const promptTokens = estimateContextTokens([{ role: 'user', content: COMPACT_PROMPT }]);
  const systemTokens = system ? estimateMessageTokens(system) : 0;
  let trimmed = toSummarize;
  while (
    trimmed.length > 2 &&
    systemTokens + estimateContextTokens(trimmed) + promptTokens > opts.contextLength * 0.85
  ) {
    trimmed = trimmed.slice(1);
  }

  const attempt = async (promptSuffix: string, format?: Record<string, unknown>): Promise<string> => {
    const request: ChatMessage[] = [
      ...(system ? [system] : []),
      ...trimmed,
      { role: 'user', content: COMPACT_PROMPT + promptSuffix },
    ];
    let text = '';
    for await (const chunk of opts.provider.chat({
      model: opts.model,
      messages: request,
      // deliberately NO tools — native tool calls are impossible on this request
      temperature: 0.2,
      contextLength: opts.contextLength,
      thinking: opts.thinking,
      think: opts.think,
      format,
      signal: opts.signal,
    })) {
      if (chunk.type === 'text') text += chunk.text;
    }
    return text.trim();
  };

  let summary = await attempt('');
  if (countSections(summary) >= MIN_ACCEPT_SECTIONS) return { summary, degraded: false };

  // Retry. Where the server supports grammar enforcement, constrain the retry
  // to the six-section JSON schema instead of asking nicely again.
  let retry = '';
  if (opts.provider.capabilities().grammar) {
    try {
      const rendered = renderJsonSummary(await attempt(SUMMARY_JSON_SUFFIX, SUMMARY_SCHEMA));
      if (rendered) retry = rendered;
    } catch {
      // e.g. the server rejects format together with thinking — fall through
    }
  }
  if (!retry) retry = await attempt(COMPACT_RETRY_SUFFIX);
  if (countSections(retry) >= MIN_ACCEPT_SECTIONS) return { summary: retry, degraded: false };
  // Keep the better of the two rather than losing the session.
  summary = countSections(retry) >= countSections(summary) ? retry : summary;
  return { summary, degraded: true };
}
