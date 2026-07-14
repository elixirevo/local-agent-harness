/**
 * Compact line diff for approval previews. Boundary trimming (common
 * prefix/suffix) instead of a full LCS: O(n), and typical tool calls edit one
 * contiguous region, which trimming captures exactly. The output is plain
 * text with "-"/"+" prefixes — the UI layer decides how to colorize.
 */

const MAX_LINE_CHARS = 120;

export interface DiffOptions {
  /** Max diff lines per side before truncation (default 8). */
  maxLines?: number;
  /** 1-based line number of the first differing line, for the hunk header. */
  startLine?: number;
}

export function renderDiff(oldText: string, newText: string, opts: DiffOptions = {}): string {
  const maxLines = opts.maxLines ?? 8;
  const a = oldText.split('\n');
  const b = newText.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const removed = a.slice(start, endA);
  const added = b.slice(start, endB);
  if (removed.length === 0 && added.length === 0) return '(no changes)';

  const lines: string[] = [`@@ line ${(opts.startLine ?? 1) + start} @@`];
  lines.push(...capped('-', removed, maxLines));
  lines.push(...capped('+', added, maxLines));
  return lines.join('\n');
}

function capped(prefix: string, ls: string[], max: number): string[] {
  const shown = ls.slice(0, max).map((l) => `${prefix} ${clip(l)}`);
  if (ls.length > max) shown.push(`${prefix} … (${ls.length - max} more lines)`);
  return shown;
}

function clip(line: string): string {
  return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line;
}

/** 1-based line number where `needle` starts inside `haystack`, if found. */
export function lineOf(haystack: string, needle: string): number | undefined {
  const idx = haystack.indexOf(needle);
  if (idx < 0) return undefined;
  let line = 1;
  for (let i = 0; i < idx; i++) if (haystack.charCodeAt(i) === 10) line++;
  return line;
}
