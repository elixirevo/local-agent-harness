export const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

const wrap = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);

export const dim = wrap('2');
export const bold = wrap('1');
export const green = wrap('32');
export const red = wrap('31');
export const cyan = wrap('36');
export const inverse = wrap('7');

/** Visible length of a string, ignoring ANSI SGR escape sequences. */
export function visibleLength(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}

/**
 * Terminal column width of a single code point. East-Asian wide characters
 * (Hangul, CJK, kana, fullwidth forms, most emoji) take 2 columns; combining
 * marks and zero-width joiners take 0. Everything else is 1. Approximate but
 * covers the cases that break cursor math — notably composed Hangul.
 */
export function charWidth(cp: number): number {
  if (cp === 0) return 0;
  if (
    (cp >= 0x0300 && cp <= 0x036f) || // combining diacriticals
    (cp >= 0x1160 && cp <= 0x11ff) || // Hangul jamo medial/final (combining)
    cp === 0x200b ||
    cp === 0x200d ||
    (cp >= 0xfe00 && cp <= 0xfe0f) // variation selectors
  ) {
    return 0;
  }
  if (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul jamo leading
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables (composed Korean)
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

/** Terminal column width of a string (sum of per-code-point widths). */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += charWidth(ch.codePointAt(0) ?? 0);
  return w;
}

/**
 * Truncate a possibly-ANSI-colored string to `width` terminal columns,
 * preserving escape sequences and closing any open color before the marker.
 */
export function truncateAnsi(s: string, width: number): string {
  const visible = s.replace(/\x1b\[[0-9;]*m/g, '');
  if (displayWidth(visible) <= width) return s;
  const parts = s.split(/(\x1b\[[0-9;]*m)/);
  let out = '';
  let used = 0;
  for (const part of parts) {
    if (part.startsWith('\x1b[')) {
      out += part;
      continue;
    }
    for (const ch of part) {
      const w = charWidth(ch.codePointAt(0) ?? 0);
      if (used + w > width - 1) return `${out}\x1b[0m…`;
      out += ch;
      used += w;
    }
  }
  return out;
}
