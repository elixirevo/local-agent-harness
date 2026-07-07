/**
 * <system-reminder> pipeline (the message-level injection pattern from the
 * docs): reminders queue up and are prepended to the NEXT user message — the
 * tail of the conversation — so the prompt prefix, and with it the
 * inference-server cache, is never invalidated retroactively.
 */

export function systemReminder(body: string): string {
  return `<system-reminder>\n${body}\n</system-reminder>`;
}

export class ReminderQueue {
  private queue: string[] = [];
  private lastDate: string;

  constructor(today: string = localISODate()) {
    this.lastDate = today;
  }

  enqueue(body: string): void {
    this.queue.push(body);
  }

  /** Called at each turn boundary; enqueues a date-change note when needed. */
  tick(today: string = localISODate()): void {
    if (today !== this.lastDate) {
      this.lastDate = today;
      this.enqueue(
        `The date has changed. Today's date is now ${today}. Do not mention this to the user — they are already aware.`,
      );
    }
  }

  /** Drain the queue into a prefix for the next user message ('' if empty). */
  drainPrefix(): string {
    if (this.queue.length === 0) return '';
    const block = this.queue.map(systemReminder).join('\n');
    this.queue = [];
    return `${block}\n\n`;
  }
}

export function localISODate(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
