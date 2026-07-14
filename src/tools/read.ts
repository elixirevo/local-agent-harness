import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { PromptTier } from '../models/profile.js';
import { err, type Tool, type ToolContext, type ToolResult } from './types.js';

export const MAX_READ_LINES = 2000;
const MAX_LINE_CHARS = 2000;

export function resolvePath(p: string, ctx: ToolContext): string {
  const abs = path.isAbsolute(p) ? path.normalize(p) : path.resolve(ctx.cwd, p);
  // Mention-marker recovery: models sometimes copy the user's "@path" into
  // tool calls verbatim. When the literal path does not exist but the path
  // without the leading @ does, use the real file. A file genuinely named
  // with a leading @ still wins — the literal is checked first.
  if (p.startsWith('@') && !fs.existsSync(abs)) {
    const stripped = p.slice(1);
    const cand = path.isAbsolute(stripped) ? path.normalize(stripped) : path.resolve(ctx.cwd, stripped);
    if (fs.existsSync(cand)) return cand;
  }
  return abs;
}

/** Fast content fingerprint for the write/edit optimistic lock (not security). */
export function hashContent(data: Buffer | string): string {
  return crypto.createHash('sha1').update(data).digest('hex');
}

export function relPath(abs: string, ctx: ToolContext): string {
  const rel = path.relative(ctx.cwd, abs);
  return rel.startsWith('..') ? abs : rel || '.';
}

export const readTool: Tool = {
  name: 'Read',
  isReadOnly: true,
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Path to the file (absolute, or relative to the working directory)' },
      offset: { type: 'integer', description: '1-based line number to start reading from' },
      limit: { type: 'integer', description: 'Maximum number of lines to read' },
    },
    required: ['file_path'],
  },

  description(tier: PromptTier): string {
    if (tier === 'minimal') {
      return 'Read a file. Returns line-numbered content. You MUST read a file before editing it.';
    }
    return [
      'Reads a file from the local filesystem.',
      '- file_path may be absolute or relative to the working directory.',
      '- Returns content with line numbers in "cat -n" format (line number, tab, content). NEVER include these prefixes when quoting file content or building an Edit old_string.',
      `- By default reads up to ${MAX_READ_LINES} lines from the start; pass offset (1-based) and limit for other ranges. The output says when it was truncated.`,
      '- You MUST read a file before editing or overwriting it.',
      '- Reading a directory fails — use Glob to list files instead.',
    ].join('\n');
  },

  summarize(input, ctx) {
    return typeof input.file_path === 'string' ? relPath(resolvePath(input.file_path, ctx), ctx) : '?';
  },

  async call(input, ctx): Promise<ToolResult> {
    const abs = resolvePath(input.file_path as string, ctx);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      return err(`File not found: ${abs}. Check the path — use Glob to find files by name.`);
    }
    if (stat.isDirectory()) {
      return err(`${abs} is a directory, not a file. Use Glob to list files in it.`);
    }
    const raw = fs.readFileSync(abs);
    if (raw.subarray(0, 8192).includes(0)) {
      ctx.readFiles.set(abs, { mtimeMs: stat.mtimeMs, hash: hashContent(raw) });
      return err(`${abs} looks like a binary file (${stat.size} bytes) — not showing its content.`);
    }
    const text = raw.toString('utf8');
    ctx.readFiles.set(abs, { mtimeMs: stat.mtimeMs, hash: hashContent(raw) });
    if (text.length === 0) {
      return { ok: true, output: '(the file exists but is empty)', display: 'empty file' };
    }

    const lines = text.split('\n');
    const start = Math.max(1, typeof input.offset === 'number' ? (input.offset as number) : 1);
    const limit = Math.min(MAX_READ_LINES, typeof input.limit === 'number' ? (input.limit as number) : MAX_READ_LINES);
    const slice = lines.slice(start - 1, start - 1 + limit);
    const numbered = slice
      .map((line, i) => {
        const shown = line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line;
        return `${String(start + i).padStart(6)}\t${shown}`;
      })
      .join('\n');
    const shownEnd = start - 1 + slice.length;
    const truncated =
      shownEnd < lines.length
        ? `\n\n(showing lines ${start}-${shownEnd} of ${lines.length} — pass offset/limit to read more)`
        : '';
    return {
      ok: true,
      output: numbered + truncated,
      display: `${slice.length} lines${truncated ? ` of ${lines.length}` : ''}`,
    };
  },
};
