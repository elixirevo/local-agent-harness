export type BashRisk = 'read' | 'mutate' | 'destructive';

/**
 * Conservative shell-command risk classifier. Two layers:
 * 1. whole-string destructive patterns (quote-blind on purpose — they also
 *    catch commands hidden in $(...) substitutions; a false positive costs
 *    one y/N prompt, a false negative costs data)
 * 2. per-segment first-token classification for read vs mutate
 * Anything unrecognized or unparseable is "mutate".
 */
export function classifyCommand(command: string): BashRisk {
  if (DESTRUCTIVE_PATTERNS.some((re) => re.test(command))) return 'destructive';

  const segments = splitSegments(command);
  if (segments.length === 0) return 'mutate';

  let risk: BashRisk = 'read';
  for (const segment of segments) {
    const segmentRisk = classifySegment(segment);
    if (segmentRisk === 'mutate') risk = 'mutate';
  }
  return risk;
}

const DESTRUCTIVE_PATTERNS: RegExp[] = [
  /\brm\b/, // includes `git rm`; grep'ing for the string "rm" trips this — acceptable false positive
  /\brmdir\b/,
  /\bsudo\b/,
  /\bmkfs/,
  /\bdd\b/,
  /\bkill(all)?\b/,
  /\bpkill\b/,
  /\bshutdown\b|\breboot\b|\bhalt\b/,
  /\bgit\s+push\b/, // visible to others — even without --force
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\b[^|;&]*-[a-zA-Z]*f/,
  /\bgit\s+checkout\s+--\s/, // discards working-tree changes
  /\bgit\s+branch\b[^|;&]*\s-D\b/,
  /\b(npm|yarn|pnpm)\s+publish\b/,
  /\|\s*(ba|z|da)?sh\b/, // piping downloads into a shell
  /\b(chmod|chown)\s+-[a-zA-Z]*R/,
  /--no-verify\b/, // bypassing hooks is exactly the shortcut the docs forbid
  /\btruncate\s+-s\b/,
];

const READ_COMMANDS = new Set([
  'ls', 'cat', 'head', 'tail', 'less', 'more', 'wc', 'grep', 'rg', 'find', 'fd',
  'pwd', 'echo', 'printf', 'which', 'whereis', 'file', 'stat', 'du', 'df',
  'ps', 'env', 'printenv', 'date', 'whoami', 'uname', 'hostname', 'id',
  'history', 'type', 'sleep', 'true', 'false', 'diff', 'sort', 'uniq', 'cut',
  'awk', 'sed', 'tr', 'basename', 'dirname', 'realpath', 'readlink', 'tree',
]);

const GIT_READ_SUBCOMMANDS = new Set([
  'status', 'log', 'diff', 'show', 'shortlog', 'blame', 'reflog', 'ls-files',
  'rev-parse', 'describe', 'grep', 'cat-file', 'config',
]);

/** Wrappers whose real command is the next token. */
const TRANSPARENT_WRAPPERS = new Set(['nohup', 'time', 'nice', 'command', 'exec']);

function classifySegment(segment: string): 'read' | 'mutate' {
  // Redirections write files; command substitution can hide anything.
  if (hasUnquoted(segment, '>') || hasUnquoted(segment, '`') || segment.includes('$(')) {
    return 'mutate';
  }
  const tokens = tokenize(segment);
  if (tokens.length === 0) return 'mutate';

  let i = 0;
  while (i < tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]) || TRANSPARENT_WRAPPERS.has(tokens[i]))) {
    i++;
  }
  const cmd = tokens[i];
  if (!cmd) return 'mutate';

  if (cmd === 'git') {
    const sub = tokens[i + 1];
    if (!sub) return 'read';
    if (sub === 'branch' || sub === 'tag' || sub === 'stash' || sub === 'remote') {
      // list-y unless followed by a mutating flag/verb
      const rest = tokens.slice(i + 2);
      const mutating = rest.some(
        (t) => /^-[a-zA-Z]*[dDmM]/.test(t) || ['add', 'set-url', 'rename', 'remove', 'rm', 'pop', 'drop', 'apply', 'push'].includes(t),
      );
      return mutating ? 'mutate' : 'read';
    }
    return GIT_READ_SUBCOMMANDS.has(sub) ? 'read' : 'mutate';
  }

  return READ_COMMANDS.has(cmd) ? 'read' : 'mutate';
}

function splitSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      current += c;
      if (c === quote && command[i - 1] !== '\\') quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      current += c;
    } else if (c === ';' || c === '|' || c === '&' || c === '\n') {
      if (current.trim()) segments.push(current.trim());
      current = '';
    } else {
      current += c;
    }
  }
  if (quote !== null) return []; // unbalanced quotes — refuse to parse (→ mutate)
  if (current.trim()) segments.push(current.trim());
  return segments;
}

function hasUnquoted(segment: string, char: string): boolean {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i];
    if (quote) {
      if (c === quote && segment[i - 1] !== '\\') quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === char) {
      return true;
    }
  }
  return false;
}

function tokenize(segment: string): string[] {
  return segment.split(/\s+/).filter(Boolean);
}
