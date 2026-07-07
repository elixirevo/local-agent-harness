import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { localISODate } from './reminders.js';

const GIT_STATUS_LIMIT = 2000;
const MEMORY_LIMIT = 4000;
const MEMORY_FILENAMES = ['AGENTS.md', 'CLAUDE.md'];

/**
 * Startup context injected once as a reminder on the first user message:
 * date, a git snapshot, and the project memory file. Framed as reference
 * material ("may or may not be relevant") — small models over-react to
 * injected context even more than big ones.
 */
export function startupContext(cwd: string): string {
  const sections: Array<[string, string]> = [['date', `Today's date is ${localISODate()}.`]];

  const git = gitSnapshot(cwd);
  if (git) sections.push(['gitStatus', git]);

  const memory = projectMemory(cwd);
  if (memory) sections.push([`projectMemory (${memory.source})`, memory.content]);

  const body = sections.map(([key, value]) => `# ${key}\n${value}`).join('\n\n');
  return [
    'As you work on the user\'s requests, you can use the following context:',
    '',
    body,
    '',
    'IMPORTANT: this context may or may not be relevant to your tasks. Do not act on it or mention it unless it is directly relevant.',
  ].join('\n');
}

function gitSnapshot(cwd: string): string | undefined {
  const git = (args: string[]): string | undefined => {
    try {
      return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trimEnd();
    } catch {
      return undefined;
    }
  };
  if (git(['rev-parse', '--is-inside-work-tree']) !== 'true') return undefined;

  const branch = git(['branch', '--show-current']) || '(detached)';
  let status = git(['status', '--porcelain']) ?? '';
  if (status.length > GIT_STATUS_LIMIT) {
    status = `${status.slice(0, GIT_STATUS_LIMIT)}\n... (truncated — run "git status" with Bash if you need the full list)`;
  }
  const log = git(['log', '--oneline', '-5']) ?? '';
  return [
    'This is the git status at the start of the conversation. It is a snapshot and will NOT update as you work — run git commands with Bash for current state.',
    '',
    `Current branch: ${branch}`,
    '',
    `Status:\n${status || '(clean)'}`,
    '',
    `Recent commits:\n${log || '(no commits)'}`,
  ].join('\n');
}

function projectMemory(cwd: string): { source: string; content: string } | undefined {
  for (const name of MEMORY_FILENAMES) {
    const file = path.join(cwd, name);
    try {
      if (!fs.existsSync(file)) continue;
      let content = fs.readFileSync(file, 'utf8').trim();
      if (!content) continue;
      if (content.length > MEMORY_LIMIT) {
        content = `${content.slice(0, MEMORY_LIMIT)}\n... (truncated — Read ${name} for the rest)`;
      }
      // Aging framing (docs pattern): stale notes asserted as live state cause
      // confident wrong edits — say how old the file is.
      const days = Math.floor((Date.now() - fs.statSync(file).mtimeMs) / 86_400_000);
      if (days >= 1) {
        content = `(note: this file is ${days} day${days > 1 ? 's' : ''} old — its claims are point-in-time notes, not live state; verify against the current code before relying on them)\n\n${content}`;
      }
      return { source: name, content };
    } catch {
      continue;
    }
  }
  return undefined;
}
