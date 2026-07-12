import { spawn } from 'node:child_process';
import type { PromptTier } from '../models/profile.js';
import { classifyCommand, type BashRisk } from '../permissions/bashClassifier.js';
import { wrapCommand } from '../sandbox/exec.js';
import { err, type SandboxState, type Tool, type ToolResult } from './types.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_CHARS = 30_000;
const HEAD_CHARS = 15_000;
const CAPTURE_LIMIT_BYTES = 2 * 1024 * 1024;

/** Does this call run inside the sandbox? (bypass honored unless forced) */
function runsSandboxed(input: Record<string, unknown>, sandbox: SandboxState | undefined): boolean {
  if (!sandbox) return false;
  return sandbox.forced === true || input.unsandboxed !== true;
}

export const bashTool: Tool & { riskOf(input: Record<string, unknown>): BashRisk } = {
  name: 'Bash',
  isReadOnly: false,
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to execute' },
      timeout: { type: 'integer', description: `Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS})` },
      unsandboxed: {
        type: 'boolean',
        description:
          'Set true ONLY after a command was blocked by the sandbox and it genuinely needs network access or writes outside the working directory. The user will be asked to approve.',
      },
    },
    required: ['command'],
  },

  description(tier: PromptTier): string {
    if (tier === 'minimal') {
      return 'Run a shell command in the working directory. Use dedicated tools (Read/Grep/Glob/Edit) for file work; Bash is for builds, tests, git.';
    }
    return [
      'Executes a shell command in the working directory and returns stdout/stderr with the exit code.',
      '- Use Bash for system commands: builds, tests, git, package managers.',
      '- Do NOT use Bash for file work a dedicated tool covers: Read (not cat/head/tail), Grep (not grep/rg), Glob (not find/ls), Edit/Write (not sed/echo redirection). Dedicated tools are safer and their output is formatted for you.',
      '- Commands run one at a time and state does not persist between calls except the filesystem (no cd carrying over; run from the working directory or use absolute paths).',
      `- Long output is truncated to ${MAX_OUTPUT_CHARS} characters keeping the head and tail.`,
      `- Default timeout ${DEFAULT_TIMEOUT_MS / 1000}s; pass timeout (ms) for longer runs, max ${MAX_TIMEOUT_MS / 1000}s.`,
      '- Destructive commands (rm, git push, sudo, ...) require user approval — if approval is denied, do not look for a workaround; ask the user.',
      '- Commands may run inside an OS sandbox (writes limited to the working directory and temp dirs, network blocked). A blocked command tells you how to escalate; prefer working within the sandbox.',
    ].join('\n');
  },

  summarize(input) {
    const cmd = String(input.command ?? '?').replace(/\s+/g, ' ');
    const tag = input.unsandboxed === true ? ' [unsandboxed]' : '';
    return (cmd.length > 80 ? `${cmd.slice(0, 80)}…` : cmd) + tag;
  },

  riskOf(input): BashRisk {
    const risk = typeof input.command === 'string' ? classifyCommand(input.command) : 'mutate';
    // Leaving the sandbox is never a plain read — it must reach the gate.
    if (input.unsandboxed === true && risk === 'read') return 'mutate';
    return risk;
  },

  sandboxedRun(input, ctx): boolean {
    return runsSandboxed(input, ctx.sandbox);
  },

  async call(input, ctx): Promise<ToolResult> {
    const command = input.command as string;
    const timeout = Math.min(
      typeof input.timeout === 'number' ? (input.timeout as number) : DEFAULT_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
    );
    const sandboxed = runsSandboxed(input, ctx.sandbox);

    const result = await run(command, ctx.cwd, timeout, sandboxed ? ctx.sandbox : undefined);
    let body = formatOutput(result);
    if (result.timedOut) {
      return err(`command timed out after ${timeout}ms and was killed.\n${body}`);
    }
    if (sandboxed && result.code !== 0 && SANDBOX_DENIAL.test(`${result.stdout}\n${result.stderr}`)) {
      body += ctx.sandbox?.forced
        ? '\n\n<system-reminder>This command ran inside a mandatory sandbox (writes limited to the working directory and temp dirs; network blocked). The restriction cannot be lifted here — work within it or report the limitation.</system-reminder>'
        : '\n\n<system-reminder>This command ran inside a sandbox: writes are limited to the working directory and temp dirs, and network is blocked. If the command legitimately needs more, retry with unsandboxed: true — the user will be asked to approve.</system-reminder>';
    }
    return {
      ok: true, // non-zero exit is information for the model, not a harness error
      output: body,
      display: `exit ${result.code}${result.timedOut ? ' (timeout)' : ''} · ${(result.ms / 1000).toFixed(1)}s${sandboxed ? ' · sandboxed' : ''}`,
    };
  },
};

const SANDBOX_DENIAL = /operation not permitted|sandbox-exec|deny(?:ed)? /i;

interface RunResult {
  stdout: string;
  stderr: string;
  code: number | string;
  timedOut: boolean;
  ms: number;
}

function run(command: string, cwd: string, timeout: number, sandbox?: SandboxState): Promise<RunResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    // Sandboxed: sandbox-exec -p <profile> /bin/sh -c <command> — the same
    // /bin/sh -c the shell:true path uses, so command semantics match.
    const child = sandbox
      ? (() => {
          const w = wrapCommand(command, sandbox.profile);
          return spawn(w.file, w.args, { cwd, timeout, killSignal: 'SIGKILL' });
        })()
      : spawn(command, { shell: true, cwd, timeout, killSignal: 'SIGKILL' });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => {
      if (stdout.length < CAPTURE_LIMIT_BYTES) stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < CAPTURE_LIMIT_BYTES) stderr += d.toString('utf8');
    });
    child.on('error', (e) => {
      resolve({ stdout, stderr: `${stderr}\n${e.message}`, code: 'spawn-error', timedOut: false, ms: Date.now() - started });
    });
    child.on('close', (code, signal) => {
      resolve({
        stdout,
        stderr,
        code: code ?? `signal:${signal}`,
        timedOut: signal === 'SIGKILL' && Date.now() - started >= timeout,
        ms: Date.now() - started,
      });
    });
  });
}

function formatOutput(r: RunResult): string {
  const parts: string[] = [];
  const out = truncateMiddle(r.stdout.trimEnd());
  const errOut = truncateMiddle(r.stderr.trimEnd());
  if (out) parts.push(out);
  if (errOut) parts.push(`--- stderr ---\n${errOut}`);
  if (parts.length === 0) parts.push('(no output)');
  parts.push(`(exit code ${r.code})`);
  return parts.join('\n');
}

/** Keep head and tail — test runners put the failure summary at the end. */
function truncateMiddle(s: string): string {
  if (s.length <= MAX_OUTPUT_CHARS) return s;
  const tail = MAX_OUTPUT_CHARS - HEAD_CHARS;
  return `${s.slice(0, HEAD_CHARS)}\n\n... (${s.length - MAX_OUTPUT_CHARS} characters omitted) ...\n\n${s.slice(-tail)}`;
}
