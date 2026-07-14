import fs from 'node:fs';
import type { PromptTier } from '../models/profile.js';
import { lineOf, renderDiff } from './diff.js';
import { hashContent, relPath, resolvePath } from './read.js';
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

  preview(input, ctx) {
    try {
      const oldString = String(input.old_string ?? '');
      const newString = String(input.new_string ?? '');
      let startLine: number | undefined;
      try {
        const file = fs.readFileSync(resolvePath(input.file_path as string, ctx), 'utf8');
        startLine = lineOf(file, oldString);
      } catch {
        /* header falls back to line 1 within the snippet */
      }
      const diff = renderDiff(oldString, newString, { startLine });
      return input.replace_all === true ? `${diff}\n(replace all occurrences)` : diff;
    } catch {
      return undefined; // preview must never block the approval flow
    }
  },

  async call(input, ctx): Promise<ToolResult> {
    const abs = resolvePath(input.file_path as string, ctx);
    const oldString = input.old_string as string;
    let newString = input.new_string as string;
    const replaceAll = input.replace_all === true;

    if (oldString === newString) return err('old_string and new_string are identical — nothing to change.');

    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      return err(`File not found: ${abs}.`);
    }
    const mark = ctx.readFiles.get(abs);
    if (mark === undefined) {
      return err(`You must Read ${abs} before editing it.`);
    }
    // mtime is the fast path; fall back to a content hash so an mtime-only
    // change (a formatter, an editor, a preview server rewriting identical
    // bytes) is not a false conflict — only a real content change blocks.
    if (stat.mtimeMs !== mark.mtimeMs && hashContent(fs.readFileSync(abs)) !== mark.hash) {
      return err(
        'File was modified on disk (its content changed) since you last read it. Read it again before editing.',
      );
    }

    const text = fs.readFileSync(abs, 'utf8');
    const match = findTarget(text, oldString);
    // A model copying line-number prefixes into old_string does it in
    // new_string too — writing that verbatim would corrupt the file.
    if (match.kind === 'found' && match.note && looksLinePrefixed(newString)) {
      newString = stripLinePrefixes(newString);
      match.note += '; line-number prefixes were also removed from new_string';
    }
    if (match.kind === 'none') {
      return err(
        'old_string was not found in the file. It must match exactly, including whitespace and indentation, without the line-number prefixes from Read. Read the file again to get the current content.',
      );
    }
    if (match.kind === 'ambiguous') {
      return err(
        'old_string does not match exactly and matches multiple locations when ignoring whitespace. Include more surrounding lines to pin down one location.',
      );
    }
    const target = match.target;
    const count = text.split(target).length - 1;
    if (count > 1 && !replaceAll) {
      return err(
        `old_string appears ${count} times in the file. Include more surrounding lines to make it unique, or set replace_all=true to replace all ${count} occurrences.`,
      );
    }

    const updated = replaceAll ? text.split(target).join(newString) : text.replace(target, newString);
    fs.writeFileSync(abs, updated, 'utf8');
    ctx.readFiles.set(abs, { mtimeMs: fs.statSync(abs).mtimeMs, hash: hashContent(updated) });

    const n = replaceAll ? count : 1;
    return {
      ok: true,
      output: `Edited ${abs} (${n} replacement${n > 1 ? 's' : ''})${match.note}.\n\n${snippetAround(updated, newString)}`,
      display: `${n} replacement${n > 1 ? 's' : ''}${match.note ? ' (recovered match)' : ''}`,
    };
  },
};

type TargetMatch =
  | { kind: 'found'; target: string; note: string }
  | { kind: 'none' }
  | { kind: 'ambiguous' };

const LINE_PREFIX_RE = /^\s{0,6}\d+(\t| {2,})/;

/** True when every non-empty line carries a Read-style line-number prefix. */
function looksLinePrefixed(s: string): boolean {
  const lines = s.split('\n').filter((l) => l.trim() !== '');
  return lines.length > 0 && lines.every((l) => LINE_PREFIX_RE.test(l));
}

/**
 * Recovery ladder for the dominant small-model failure ("old_string not
 * found"): 1) exact match, 2) exact match after stripping the line-number
 * prefixes that models copy from Read output, 3) unique line-window match
 * ignoring per-line surrounding whitespace. Silent leniency here beats an
 * error loop; the result notes when a recovery kicked in so the model learns.
 */
function findTarget(text: string, oldString: string): TargetMatch {
  if (text.includes(oldString)) return { kind: 'found', target: oldString, note: '' };

  const stripped = stripLinePrefixes(oldString);
  if (stripped !== oldString && text.includes(stripped)) {
    return {
      kind: 'found',
      target: stripped,
      note: ' (matched after removing line-number prefixes from old_string — never include them)',
    };
  }

  const fuzzy = trimmedWindowMatch(text, stripped);
  if (fuzzy === 'multiple') return { kind: 'ambiguous' };
  if (fuzzy !== 'none') {
    return {
      kind: 'found',
      target: fuzzy,
      note: ' (matched ignoring surrounding whitespace — send exact content next time)',
    };
  }
  return { kind: 'none' };
}

function stripLinePrefixes(s: string): string {
  return s
    .split('\n')
    .map((l) => l.replace(LINE_PREFIX_RE, ''))
    .join('\n');
}

/** Unique window of file lines equal to the old lines after per-line trim. */
function trimmedWindowMatch(text: string, oldString: string): string | 'none' | 'multiple' {
  const oldLines = oldString.split('\n').map((l) => l.trim());
  while (oldLines.length > 0 && oldLines[0] === '') oldLines.shift();
  while (oldLines.length > 0 && oldLines[oldLines.length - 1] === '') oldLines.pop();
  if (oldLines.length === 0) return 'none';

  const fileLines = text.split('\n');
  const hits: number[] = [];
  for (let i = 0; i + oldLines.length <= fileLines.length; i++) {
    let matches = true;
    for (let k = 0; k < oldLines.length; k++) {
      if (fileLines[i + k].trim() !== oldLines[k]) {
        matches = false;
        break;
      }
    }
    if (matches) hits.push(i);
  }
  if (hits.length === 0) return 'none';
  if (hits.length > 1) return 'multiple';
  return fileLines.slice(hits[0], hits[0] + oldLines.length).join('\n');
}

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
