import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface SandboxPolicy {
  /** Directories the command may write into (absolute paths). */
  writePaths: string[];
  allowNetwork: boolean;
}

/** Escape a path for a Seatbelt string literal. */
function sbString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Build a Seatbelt (sandbox-exec) profile: everything allowed except file
 * writes outside the policy paths, and network unless opted in. Reads stay
 * open on purpose — blocking them breaks builds and tools, and with the
 * network denied whatever gets read cannot leave the machine.
 */
export function buildSeatbeltProfile(policy: SandboxPolicy): string {
  const writes = new Set<string>();
  const add = (p: string) => {
    const abs = path.resolve(p);
    writes.add(abs);
    // Seatbelt matches post-resolution paths (/tmp → /private/tmp), so allow
    // the realpath alongside what was declared.
    try {
      writes.add(fs.realpathSync(abs));
    } catch {
      /* keep the declared path for not-yet-existing dirs */
    }
  };
  for (const p of policy.writePaths) add(p);
  add('/private/tmp');
  add('/private/var/folders'); // per-user TMPDIR lives here
  add(os.tmpdir());

  const writeRules = [...writes].map((w) => `(subpath ${sbString(w)})`).join(' ');
  return [
    '(version 1)',
    '(allow default)',
    ...(policy.allowNetwork ? [] : ['(deny network*)']),
    '(deny file-write*)',
    `(allow file-write* ${writeRules} (literal "/dev/null"))`,
  ].join('\n');
}
