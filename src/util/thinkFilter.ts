export interface ThinkEvent {
  type: 'thinking' | 'text';
  text: string;
}

const OPEN = '<think>';
const CLOSE = '</think>';

/**
 * Splits a streamed completion into thinking/text events for models that emit
 * a leading `<think>...</think>` block as plain text (Qwen3, DeepSeek-R1 family).
 *
 * Only a block at the very start of the response (after optional whitespace) is
 * treated as thinking; tags appearing later are passed through as ordinary text.
 * Tags split across arbitrary chunk boundaries are handled.
 *
 * Known gap: some DeepSeek-R1 templates start the response already inside the
 * think block (no opening tag). That degrades to "everything is text" here.
 */
export class ThinkTagStream {
  private state: 'start' | 'thinking' | 'text' = 'start';
  private buf = '';
  private trimNext = false;

  push(delta: string): ThinkEvent[] {
    this.buf += delta;
    const out: ThinkEvent[] = [];
    let advanced = true;
    while (advanced) {
      advanced = false;
      if (this.state === 'start') {
        const rest = this.buf.replace(/^\s+/, '');
        if (rest.length === 0) break; // only whitespace so far — keep waiting
        if (rest.startsWith(OPEN)) {
          this.state = 'thinking';
          this.buf = rest.slice(OPEN.length);
          advanced = true;
        } else if (OPEN.startsWith(rest)) {
          break; // could still turn out to be "<think>"
        } else {
          this.state = 'text'; // not a think block — emit everything incl. leading whitespace
          advanced = true;
        }
      } else if (this.state === 'thinking') {
        const idx = this.buf.indexOf(CLOSE);
        if (idx !== -1) {
          if (idx > 0) out.push({ type: 'thinking', text: this.buf.slice(0, idx) });
          this.buf = this.buf.slice(idx + CLOSE.length);
          this.state = 'text';
          this.trimNext = true; // models pad "</think>\n\n" before the answer
          advanced = true;
        } else {
          const hold = partialSuffix(this.buf, CLOSE);
          const emit = this.buf.slice(0, this.buf.length - hold);
          if (emit) out.push({ type: 'thinking', text: emit });
          this.buf = this.buf.slice(this.buf.length - hold);
          break;
        }
      } else {
        if (this.trimNext) {
          this.buf = this.buf.replace(/^\s+/, '');
          if (!this.buf) break;
          this.trimNext = false;
        }
        if (this.buf) {
          out.push({ type: 'text', text: this.buf });
          this.buf = '';
        }
        break;
      }
    }
    return out;
  }

  /** Call once at stream end to release anything still buffered. */
  flush(): ThinkEvent[] {
    const out: ThinkEvent[] = [];
    if (this.buf) {
      if (this.state === 'thinking') {
        // unclosed think block — stream ended mid-reasoning
        out.push({ type: 'thinking', text: this.buf });
      } else if (this.state === 'start') {
        // never resolved into a tag (e.g. response was just whitespace or "<thin")
        out.push({ type: 'text', text: this.buf });
      }
      // state 'text' can only hold trailing whitespace pending trimNext — drop it
    }
    this.buf = '';
    return out;
  }
}

/** Length of the longest suffix of `s` that is a proper prefix of `pat`. */
function partialSuffix(s: string, pat: string): number {
  const max = Math.min(s.length, pat.length - 1);
  for (let k = max; k > 0; k--) {
    if (pat.startsWith(s.slice(s.length - k))) return k;
  }
  return 0;
}
