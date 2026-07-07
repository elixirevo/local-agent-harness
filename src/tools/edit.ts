import fs from 'node:fs';
import type { PromptTier } from '../models/profile.js';
import { relPath, resolvePath } from './read.js';
import { err, type Tool, type ToolResult } from './types.js';

const CONTEXT_LINES = 3;

export const editTool: Tool = {
  name: 'Edit',
  isReadOnly: false,
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Path to the file (absolute, or relative to the working directory)' },
      old_string: { type: 'string', description: 'Exact text to replace (must match the file content exactly)' },
      new_string: { type: 'string', description: 'Replacement text' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence (default false)' },
    },
    required: ['file_path', 'old_string', 'new_string'],
  },

  description(tier: PromptTier): string {
    if (tier === 'minimal') {
      return 'Replace exact text in a file. Read the file first. old_string must match exactly and be unique (or set replace_all).';
    }
    return [
      'Performs an exact string replacement in one file.',
      '- You MUST have read the file with Read earlier in the conversation — this call fails otherwise.',
      '- old_string must match the file content EXACTLY, including whitespace and indentation, and must NOT include the line-number prefixes that Read displays.',
      '- Fails if old_string appears more than once: include more surrounding lines to make it unique, or set replace_all=true to replace every occurrence (useful for renames).',
      '- old_string and new_string must differ.',
    ].join('\n');
  },

  summarize(input, ctx) {
    return typeof input.file_path === 'string' ? relPath(resolvePath(input.file_path, ctx), ctx) : '?';
  },

  pathOf(input, ctx) {
    return typeof input.file_path === 'string' ? resolvePath(input.file_path, ctx) : undefined;
  },

  async call(input, ctx): Promise<ToolResult> {
    const abs = resolvePath(input.file_path as string, ctx);
    const oldString = input.old_string as string;
    const newString = input.new_string as string;
    const replaceAll = input.replace_all === true;

    if (oldString === newString) return err('old_string and new_string are identical — nothing to change.');

    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      return err(`File not found: ${abs}.`);
    }
    const readMtime = ctx.readFiles.get(abs);
    if (readMtime === undefined) {
      return err(`You must Read ${abs} before editing it.`);
    }
    if (stat.mtimeMs !== readMtime) {
      return err('File has been unexpectedly modified since you read it. Read it again before editing.');
    }

    const text = fs.readFileSync(abs, 'utf8');
    const count = text.split(oldString).length - 1;
    if (count === 0) {
      return err(
        'old_string was not found in the file. It must match exactly, including whitespace and indentation, without the line-number prefixes from Read. Read the file again to get the current content.',
      );
    }
    if (count > 1 && !replaceAll) {
      return err(
        `old_string appears ${count} times in the file. Include more surrounding lines to make it unique, or set replace_all=true to replace all ${count} occurrences.`,
      );
    }

    const updated = replaceAll ? text.split(oldString).join(newString) : text.replace(oldString, newString);
    fs.writeFileSync(abs, updated, 'utf8');
    ctx.readFiles.set(abs, fs.statSync(abs).mtimeMs);

    return {
      ok: true,
      output: `Edited ${abs} (${replaceAll ? count : 1} replacement${count > 1 && replaceAll ? 's' : ''}).\n\n${snippetAround(updated, newString)}`,
      display: `${replaceAll ? count : 1} replacement${replaceAll && count > 1 ? 's' : ''}`,
    };
  },
};

/** Line-numbered context around the first replacement so the model can verify. */
function snippetAround(text: string, needle: string): string {
  const idx = text.indexOf(needle);
  if (idx === -1) return '';
  const lines = text.split('\n');
  const lineIdx = text.slice(0, idx).split('\n').length - 1;
  const start = Math.max(0, lineIdx - CONTEXT_LINES);
  const end = Math.min(lines.length, lineIdx + needle.split('\n').length + CONTEXT_LINES);
  const shown = lines
    .slice(start, end)
    .map((l, i) => `${String(start + i + 1).padStart(6)}\t${l}`)
    .join('\n');
  return `Result around the change:\n${shown}`;
}
