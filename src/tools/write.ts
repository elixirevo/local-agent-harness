import fs from 'node:fs';
import path from 'node:path';
import type { PromptTier } from '../models/profile.js';
import { relPath, resolvePath } from './read.js';
import { err, type Tool, type ToolResult } from './types.js';

export const writeTool: Tool = {
  name: 'Write',
  isReadOnly: false,
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Path to write (absolute, or relative to the working directory)' },
      content: { type: 'string', description: 'Full content to write to the file' },
    },
    required: ['file_path', 'content'],
  },

  description(tier: PromptTier): string {
    if (tier === 'minimal') {
      return 'Write a file (overwrites). For existing files you MUST Read them first; prefer Edit for changes.';
    }
    return [
      'Writes a file to the local filesystem, creating parent directories as needed.',
      '- Overwrites the file at file_path if it already exists.',
      '- If the file exists, you MUST have read it with Read earlier in the conversation — this call fails otherwise.',
      '- Prefer Edit for modifying existing files; use Write only for new files or complete rewrites.',
      '- Do NOT create documentation files (*.md, README) unless explicitly requested.',
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
    const content = input.content as string;

    let stat: fs.Stats | undefined;
    try {
      stat = fs.statSync(abs);
    } catch {
      stat = undefined;
    }
    if (stat?.isDirectory()) return err(`${abs} is a directory.`);
    if (stat) {
      const readMtime = ctx.readFiles.get(abs);
      if (readMtime === undefined) {
        return err(
          `${abs} already exists but you have not read it in this conversation. Read it first, then Write or (better) Edit it.`,
        );
      }
      if (stat.mtimeMs !== readMtime) {
        return err('File has been unexpectedly modified since you read it. Read it again before writing.');
      }
    }

    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
    ctx.readFiles.set(abs, fs.statSync(abs).mtimeMs);
    const lines = content.split('\n').length;
    return {
      ok: true,
      output: `Wrote ${lines} lines to ${abs}.`,
      display: `${stat ? 'overwrote' : 'created'} · ${lines} lines`,
    };
  },
};
