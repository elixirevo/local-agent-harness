import fs from 'node:fs';
import path from 'node:path';
import type { ChatMessage } from '../providers/types.js';

export interface SessionMeta {
  id: string;
  createdAt: string;
  provider: string;
  model: string;
  cwd: string;
}

interface MetaLine extends SessionMeta {
  type: 'meta';
  version: 1;
}

interface MessageLine {
  type: 'message';
  message: ChatMessage;
}

/** Marks a compaction: messages after this line replace everything above it. */
interface CompactLine {
  type: 'compact';
}

export const SESSIONS_DIR = '.harness/sessions';

/**
 * Append-only JSONL transcript: line 1 is meta, each further line one
 * message. Saved incrementally after completed turns only, so a rolled-back
 * turn never reaches disk and the file always parses back to a valid history.
 */
export class SessionStore {
  readonly file: string;
  private savedCount = 0;
  private metaWritten = false;

  constructor(
    private readonly meta: SessionMeta,
    dir: string = path.join(meta.cwd, SESSIONS_DIR),
  ) {
    this.file = path.join(dir, `${meta.id}.jsonl`);
  }

  /** Persist messages beyond what was already saved. */
  append(messages: ChatMessage[]): void {
    if (messages.length <= this.savedCount && this.metaWritten) return;
    const lines: string[] = [];
    if (!this.metaWritten) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const metaLine: MetaLine = { type: 'meta', version: 1, ...this.meta };
      lines.push(JSON.stringify(metaLine));
      this.metaWritten = true;
    }
    for (const message of messages.slice(this.savedCount)) {
      const line: MessageLine = { type: 'message', message };
      lines.push(JSON.stringify(line));
    }
    if (lines.length > 0) fs.appendFileSync(this.file, `${lines.join('\n')}\n`, 'utf8');
    this.savedCount = messages.length;
  }

  /** Adopt an existing file's contents as already-saved (for resumed sessions). */
  markSaved(count: number): void {
    this.savedCount = count;
    this.metaWritten = true;
  }

  /**
   * Persist a compaction: a marker line followed by the rebuilt history.
   * The pre-compaction lines stay in the file (they are the full-transcript
   * escape hatch the model is pointed at); loading replays past the marker.
   */
  recordCompaction(messages: ChatMessage[]): void {
    const lines: string[] = [];
    if (!this.metaWritten) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const metaLine: MetaLine = { type: 'meta', version: 1, ...this.meta };
      lines.push(JSON.stringify(metaLine));
      this.metaWritten = true;
    }
    const marker: CompactLine = { type: 'compact' };
    lines.push(JSON.stringify(marker));
    for (const message of messages) {
      const line: MessageLine = { type: 'message', message };
      lines.push(JSON.stringify(line));
    }
    fs.appendFileSync(this.file, `${lines.join('\n')}\n`, 'utf8');
    this.savedCount = messages.length;
  }
}

export function newSessionId(now: Date = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

export function loadSession(cwd: string, idOrLast: string): { meta: SessionMeta; messages: ChatMessage[]; file: string } {
  const dir = path.join(cwd, SESSIONS_DIR);
  let file: string;
  if (idOrLast === 'last') {
    const candidates = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort() : [];
    if (candidates.length === 0) throw new Error(`no saved sessions found in ${dir}`);
    file = path.join(dir, candidates[candidates.length - 1]);
  } else {
    file = path.join(dir, idOrLast.endsWith('.jsonl') ? idOrLast : `${idOrLast}.jsonl`);
    if (!fs.existsSync(file)) throw new Error(`session not found: ${file}`);
  }

  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  let meta: SessionMeta | undefined;
  let messages: ChatMessage[] = [];
  for (const line of lines) {
    let parsed: MetaLine | MessageLine | CompactLine;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // tolerate a torn trailing line from a crashed process
    }
    if (parsed.type === 'meta') meta = parsed;
    else if (parsed.type === 'compact') messages = [];
    else if (parsed.type === 'message') messages.push(parsed.message);
  }
  if (!meta) throw new Error(`session file has no meta line: ${file}`);
  return { meta, messages, file };
}
