import fs from 'node:fs';
import type { SandboxConfig } from '../config/config.js';
import type { SandboxState } from '../tools/types.js';
import { buildSeatbeltProfile } from './profile.js';

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

let available: boolean | undefined;

/** Seatbelt is macOS-only; the binary check is cached for the process. */
export function sandboxAvailable(): boolean {
  if (available === undefined) {
    available = process.platform === 'darwin' && fs.existsSync(SANDBOX_EXEC);
  }
  return available;
}

export interface WrappedCommand {
  file: string;
  args: string[];
}

/**
 * sandbox-exec -p <profile> /bin/sh -c <command> — same /bin/sh -c the
 * unsandboxed path gets from spawn's shell:true, so behavior matches.
 */
export function wrapCommand(command: string, profile: string): WrappedCommand {
  return { file: SANDBOX_EXEC, args: ['-p', profile, '/bin/sh', '-c', command] };
}

/**
 * The session's sandbox state for a working directory, or undefined when
 * disabled or unsupported. `force` turns it on regardless of config and
 * marks it non-bypassable (verify subagents run approval-free, so their
 * isolation must not have an unsandboxed escape).
 */
export function sessionSandbox(cwd: string, config: SandboxConfig, force = false): SandboxState | undefined {
  if (!force && config.bash !== 'on') return undefined;
  if (!sandboxAvailable()) return undefined;
  const profile = buildSeatbeltProfile({
    writePaths: [cwd, ...config.extraWritePaths],
    allowNetwork: config.allowNetwork,
  });
  return force ? { profile, forced: true } : { profile };
}
