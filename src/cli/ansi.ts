export const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

const wrap = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);

export const dim = wrap('2');
export const bold = wrap('1');
export const green = wrap('32');
export const red = wrap('31');
export const cyan = wrap('36');

/** Visible length of a string, ignoring ANSI SGR escape sequences. */
export function visibleLength(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}
