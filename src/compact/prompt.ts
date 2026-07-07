/**
 * Compaction prompts. Two structural defenses against wasted summary turns
 * (the docs' 2.79%→0.01% lesson): the request is sent WITHOUT any tools
 * (native tool calls become impossible — a local-serving advantage), and the
 * no-tools instruction still brackets the prompt as preamble + trailer
 * because text-protocol models could imitate a <tool_call> block as text.
 */

const NO_TOOLS_PREAMBLE = [
  'CRITICAL: Respond with TEXT ONLY. Do not call any tools and do not output any <tool_call> block.',
  'You already have everything you need in the conversation above.',
  'Your entire response must be the summary described below — it will replace the conversation, so anything you omit is lost.',
].join('\n');

const SECTIONS = [
  '## 1. Task and intent\nEvery explicit user request so far, in order. Quote exact wording where it matters.',
  '## 2. Files and code\nEvery file path read or changed that still matters, with key line numbers and exact snippets for anything likely to be edited next.',
  '## 3. What was tried\nApproaches taken, errors hit, and how each was resolved (or not).',
  '## 4. User feedback\nALL corrections and instructions the user gave, verbatim where short.',
  '## 5. Current state\nPrecisely what was in progress at the cutoff: the last command/tool run, its result, and what is verified working or broken.',
  '## 6. Next step\nThe immediate next action, ONLY if it directly continues the user\'s latest request. Include a verbatim quote from the recent conversation showing the task in progress — no drift.',
].join('\n\n');

const NO_TOOLS_TRAILER =
  'REMINDER: plain text only — no tool calls, no <tool_call> blocks. Start your response with "## 1." and produce all six sections.';

export const COMPACT_PROMPT = [
  NO_TOOLS_PREAMBLE,
  '',
  'Summarize the conversation so far so the work can continue seamlessly after the earlier messages are dropped. Write exactly these six sections:',
  '',
  SECTIONS,
  '',
  // Chained compactions erode facts: each pass re-encodes the previous
  // summary. Carrying prior-summary items forward verbatim stops the decay.
  'If the conversation already contains a "# Conversation summary" block from an earlier compaction, carry EVERY fact from it forward into the matching sections — do not drop, merge away, or shorten its items.',
  'This summarization request itself is NOT part of the conversation — never quote it or list it as a user instruction.',
  '',
  NO_TOOLS_TRAILER,
].join('\n');

export const COMPACT_RETRY_SUFFIX =
  '\n\nYour previous response did not contain the six required "## N." sections. Produce ALL six numbered sections this time, starting with "## 1.".';

/** How many of the six section headings appear in a candidate summary. */
export function countSections(summary: string): number {
  let n = 0;
  for (let i = 1; i <= 6; i++) {
    if (new RegExp(`^##\\s*${i}\\.`, 'm').test(summary)) n++;
  }
  return n;
}

export function continuationBlock(transcriptPath: string | undefined): string {
  return [
    'This conversation was compacted to fit the context window. The summary below replaces the earlier messages; anything after it is preserved verbatim.',
    'File contents from before the summary are NO LONGER in context — Read files again before editing them.',
    'Continue the task directly: do not acknowledge the summary, do not recap, pick up exactly where the work left off.',
    ...(transcriptPath ? [`The full pre-compaction transcript is saved at: ${transcriptPath} (Read it if you need exact details).`] : []),
  ].join('\n');
}
