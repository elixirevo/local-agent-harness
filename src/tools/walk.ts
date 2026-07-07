import fs from 'node:fs';
import path from 'node:path';

/** Directories that are almost never what a code search wants. */
const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  'target',
  '__pycache__',
  '.venv',
  'venv',
  '.cache',
  'coverage',
]);

export interface WalkEntry {
  /** Absolute path. */
  path: string;
  /** Path relative to the walk root (posix separators). */
  rel: string;
  mtimeMs: number;
}

export const MAX_WALK_ENTRIES = 20000;

/**
 * Depth-first file walk with junk-directory pruning. Symlinks are not
 * followed (cycle safety). Stops after MAX_WALK_ENTRIES files.
 */
export function walkFiles(root: string): WalkEntry[] {
  const out: WalkEntry[] = [];
  const stack: string[] = [root];
  while (stack.length > 0 && out.length < MAX_WALK_ENTRIES) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable directory — skip, don't abort the walk
    }
    for (const entry of entries) {
      if (out.length >= MAX_WALK_ENTRIES) break;
      const abs = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name) && !entry.name.startsWith('.git')) stack.push(abs);
      } else if (entry.isFile()) {
        let mtimeMs = 0;
        try {
          mtimeMs = fs.statSync(abs).mtimeMs;
        } catch {
          continue;
        }
        out.push({ path: abs, rel: toPosix(path.relative(root, abs)), mtimeMs });
      }
    }
  }
  return out;
}

export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/**
 * Compile a glob pattern to a RegExp over posix relative paths.
 * Supports **, *, ?, {a,b}. A pattern without "/" matches basenames at any
 * depth (ripgrep --glob semantics), which is what models usually mean.
 */
export function globToRegExp(pattern: string): { re: RegExp; basenameOnly: boolean } {
  const basenameOnly = !pattern.includes('/');
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // "**/" matches zero or more directories; bare "**" matches anything
        if (pattern[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 3;
        } else {
          re += '.*';
          i += 2;
        }
      } else {
        re += '[^/]*';
        i += 1;
      }
    } else if (c === '?') {
      re += '[^/]';
      i += 1;
    } else if (c === '{') {
      const end = pattern.indexOf('}', i);
      if (end === -1) {
        re += '\\{';
        i += 1;
      } else {
        const alts = pattern
          .slice(i + 1, end)
          .split(',')
          .map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        re += `(?:${alts.join('|')})`;
        i = end + 1;
      }
    } else {
      re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      i += 1;
    }
  }
  return { re: new RegExp(`^${re}$`), basenameOnly };
}

export function matchGlob(compiled: { re: RegExp; basenameOnly: boolean }, rel: string): boolean {
  const target = compiled.basenameOnly ? rel.slice(rel.lastIndexOf('/') + 1) : rel;
  return compiled.re.test(target);
}
