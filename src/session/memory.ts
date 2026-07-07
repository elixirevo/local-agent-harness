import fs from 'node:fs';
import path from 'node:path';
import { localISODate } from '../context/reminders.js';

const MEMORY_HEADING = '## Harness notes';
const MEMORY_FILE = 'AGENTS.md';

/**
 * Append a note to the project's AGENTS.md under a managed "## Harness notes"
 * section. Deliberately the safe, manual half of session memory (invoked only
 * by the user's /remember): append-only, never rewrites the user's own
 * content, and the next session's startup context reads it back automatically.
 * The aging framing in startup.ts keeps stale notes from being trusted as
 * live state.
 */
export function rememberNote(cwd: string, note: string): { file: string; created: boolean } {
  const file = path.join(cwd, MEMORY_FILE);
  const line = `- (${localISODate()}) ${note.trim()}`;
  const existed = fs.existsSync(file);
  let content = existed ? fs.readFileSync(file, 'utf8') : '';

  if (content.includes(MEMORY_HEADING)) {
    // Insert right after the heading so notes stay grouped, newest last.
    const idx = content.indexOf(MEMORY_HEADING) + MEMORY_HEADING.length;
    const rest = content.slice(idx).replace(/^\n+/, '');
    content = `${content.slice(0, idx)}\n${rest ? `${insertBeforeNextHeading(rest, line)}` : `${line}\n`}`;
  } else {
    const sep = content && !content.endsWith('\n') ? '\n\n' : content ? '\n' : '';
    content = `${content}${sep}${MEMORY_HEADING}\n${line}\n`;
  }
  fs.writeFileSync(file, content, 'utf8');
  return { file, created: !existed };
}

/** Append the note after the section body but before the next "## " heading. */
function insertBeforeNextHeading(sectionRest: string, line: string): string {
  const nextHeading = sectionRest.search(/^## /m);
  if (nextHeading === -1) {
    return `${sectionRest.replace(/\n*$/, '')}\n${line}\n`;
  }
  const body = sectionRest.slice(0, nextHeading).replace(/\n*$/, '');
  const after = sectionRest.slice(nextHeading);
  return `${body}\n${line}\n\n${after}`;
}
