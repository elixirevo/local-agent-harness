import fs from 'node:fs';
import type { PromptTier } from '../models/profile.js';
import { resolvePath } from './read.js';
import { err, type Tool, type ToolResult } from './types.js';
import { globToRegExp, matchGlob, walkFiles } from './walk.js';

const MAX_RESULTS = 100;

export const globTool: Tool = {
  name: 'Glob',
  isReadOnly: true,
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern, e.g. "**/*.ts" or "src/**/*.{ts,tsx}"' },
      path: { type: 'string', description: 'Directory to search (default: working directory)' },
    },
    required: ['pattern'],
  },

  description(tier: PromptTier): string {
    if (tier === 'minimal') {
      return 'Find files by glob pattern (e.g. "**/*.ts"). Returns paths sorted newest-first.';
    }
    return [
      'Finds files by glob pattern.',
      '- Supports *, ?, ** and {a,b} — e.g. "**/*.ts", "src/**/*.{ts,tsx}".',
      '- A pattern without "/" matches file names at any depth (e.g. "*.ts" finds nested files too).',
      '- Returns paths relative to the search root, newest-first. Junk directories (node_modules, .git, dist, ...) are skipped.',
      '- Use this to discover files by name; use Grep to search file contents.',
    ].join('\n');
  },

  summarize(input) {
    return String(input.pattern ?? '?');
  },

  async call(input, ctx): Promise<ToolResult> {
    const root = resolvePath(typeof input.path === 'string' ? (input.path as string) : '.', ctx);
    let rootStat: fs.Stats;
    try {
      rootStat = fs.statSync(root);
    } catch {
      return err(`Search path not found: ${root}.`);
    }
    if (!rootStat.isDirectory()) return err(`Search path is not a directory: ${root}.`);

    const compiled = globToRegExp(input.pattern as string);
    const matches = walkFiles(root)
      .filter((e) => matchGlob(compiled, e.rel))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    if (matches.length === 0) {
      return { ok: true, output: `No files match "${input.pattern}" under ${root}.`, display: '0 files' };
    }
    const shown = matches.slice(0, MAX_RESULTS);
    const truncated =
      matches.length > MAX_RESULTS
        ? `\n\n(${matches.length} matches — showing the ${MAX_RESULTS} most recently modified; narrow the pattern for more)`
        : '';
    return {
      ok: true,
      output: shown.map((e) => e.rel).join('\n') + truncated,
      display: `${matches.length} file${matches.length === 1 ? '' : 's'}`,
    };
  },
};
