import fs from 'node:fs';
import type { PromptTier } from '../models/profile.js';
import { resolvePath } from './read.js';
import { err, type Tool, type ToolResult } from './types.js';
import { globToRegExp, matchGlob, walkFiles } from './walk.js';

const MAX_RESULTS = 100;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_LINE_CHARS = 500;

/**
 * Content search over the walked file tree. Pure JS scan (JavaScript regex
 * syntax) — dependency-free and deterministic; can be swapped for ripgrep
 * internally later without changing the tool contract.
 */
export const grepTool: Tool = {
  name: 'Grep',
  isReadOnly: true,
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression (JavaScript syntax) to search for' },
      path: { type: 'string', description: 'Directory to search (default: working directory)' },
      glob: { type: 'string', description: 'Only search files matching this glob, e.g. "*.ts"' },
      mode: {
        type: 'string',
        enum: ['files', 'content', 'count'],
        description: '"files" lists matching files (default), "content" shows matching lines, "count" shows per-file match counts',
      },
      case_insensitive: { type: 'boolean', description: 'Case-insensitive search (default false)' },
    },
    required: ['pattern'],
  },

  description(tier: PromptTier): string {
    if (tier === 'minimal') {
      return 'Search file contents with a regex. mode: "files" (default), "content" (matching lines), or "count".';
    }
    return [
      'Searches file contents with a regular expression (JavaScript regex syntax).',
      '- mode "files" (default) lists files containing a match, newest-first; "content" shows matching lines as path:line:text; "count" shows per-file match counts.',
      '- Filter which files are searched with glob (e.g. "*.ts") and path (search root).',
      '- Binary files and junk directories (node_modules, .git, ...) are skipped.',
      `- Output stops at ${MAX_RESULTS} results — narrow the pattern or glob when you hit that.`,
    ].join('\n');
  },

  summarize(input) {
    const g = typeof input.glob === 'string' ? ` (${input.glob})` : '';
    return `/${input.pattern}/${g}`;
  },

  async call(input, ctx): Promise<ToolResult> {
    let re: RegExp;
    try {
      re = new RegExp(input.pattern as string, input.case_insensitive === true ? 'i' : '');
    } catch (e) {
      return err(`Invalid regular expression: ${(e as Error).message}. Use JavaScript regex syntax.`);
    }
    const root = resolvePath(typeof input.path === 'string' ? (input.path as string) : '.', ctx);
    if (!fs.existsSync(root)) return err(`Search path not found: ${root}.`);
    const fileFilter = typeof input.glob === 'string' ? globToRegExp(input.glob as string) : undefined;
    const mode = typeof input.mode === 'string' ? (input.mode as string) : 'files';

    const files = walkFiles(root)
      .filter((e) => !fileFilter || matchGlob(fileFilter, e.rel))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    const fileHits: Array<{ rel: string; count: number }> = [];
    const lineHits: string[] = [];
    let truncated = false;

    outer: for (const f of files) {
      let buf: Buffer;
      try {
        if (fs.statSync(f.path).size > MAX_FILE_BYTES) continue;
        buf = fs.readFileSync(f.path);
      } catch {
        continue;
      }
      if (buf.subarray(0, 8192).includes(0)) continue; // binary
      const lines = buf.toString('utf8').split('\n');
      let count = 0;
      for (let i = 0; i < lines.length; i++) {
        if (!re.test(lines[i])) continue;
        count++;
        if (mode === 'content') {
          const line = lines[i].length > MAX_LINE_CHARS ? `${lines[i].slice(0, MAX_LINE_CHARS)}…` : lines[i];
          lineHits.push(`${f.rel}:${i + 1}:${line}`);
          if (lineHits.length >= MAX_RESULTS) {
            truncated = true;
            break outer;
          }
        } else if (mode === 'files') {
          break; // one hit is enough to list the file
        }
      }
      if (count > 0) {
        fileHits.push({ rel: f.rel, count });
        if (mode !== 'content' && fileHits.length >= MAX_RESULTS) {
          truncated = true;
          break;
        }
      }
    }

    const note = truncated ? `\n\n(stopped at ${MAX_RESULTS} results — narrow the pattern or glob)` : '';
    if (mode === 'content') {
      if (lineHits.length === 0) return { ok: true, output: noMatch(input, root), display: '0 matches' };
      return { ok: true, output: lineHits.join('\n') + note, display: `${lineHits.length} matching lines` };
    }
    if (fileHits.length === 0) return { ok: true, output: noMatch(input, root), display: '0 matches' };
    const body =
      mode === 'count'
        ? fileHits.map((h) => `${h.rel}: ${h.count}`).join('\n')
        : fileHits.map((h) => h.rel).join('\n');
    return { ok: true, output: body + note, display: `${fileHits.length} file${fileHits.length === 1 ? '' : 's'}` };
  },
};

function noMatch(input: Record<string, unknown>, root: string): string {
  const g = typeof input.glob === 'string' ? ` in files matching "${input.glob}"` : '';
  return `No matches for /${input.pattern}/${g} under ${root}.`;
}
