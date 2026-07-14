import fs from 'node:fs';
import path from 'node:path';

/**
 * "Always allow" persistence: the gate's session allowlist backed by
 * .harness/settings.json, so an "a" answer survives restarts. The gate keeps
 * calling plain Set methods — add() is patched to write through, invisible to
 * the caller. Destructive calls never consult the allowlist (gate-enforced).
 */

export function settingsPath(cwd: string): string {
  return path.join(cwd, '.harness', 'settings.json');
}

function readSettings(cwd: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath(cwd), 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {}; // missing or corrupt settings never block a session
  }
}

/** Rewrite only the allowAlways key, preserving unrelated settings. */
function writeAllowlist(cwd: string, tools: string[]): void {
  const file = settingsPath(cwd);
  const settings = { ...readSettings(cwd), allowAlways: [...tools].sort() };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
}

/** Load the persisted allowlist as a write-through Set. */
export function loadAllowlist(cwd: string): Set<string> {
  const stored = readSettings(cwd).allowAlways;
  const initial = Array.isArray(stored) ? stored.filter((t): t is string => typeof t === 'string') : [];
  const set = new Set<string>(initial);
  const plainAdd = set.add.bind(set);
  set.add = (tool: string) => {
    plainAdd(tool);
    try {
      writeAllowlist(cwd, [...set]);
    } catch {
      /* best-effort — the in-memory allowlist still works this session */
    }
    return set;
  };
  return set;
}

/** Empty the allowlist in memory and on disk. */
export function clearAllowlist(cwd: string, set: Set<string>): void {
  set.clear();
  try {
    writeAllowlist(cwd, []);
  } catch {
    /* nothing persisted to clear */
  }
}
