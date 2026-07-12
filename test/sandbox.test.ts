import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { sandboxAvailable, sessionSandbox, wrapCommand } from '../src/sandbox/exec.js';
import { buildSeatbeltProfile } from '../src/sandbox/profile.js';
import { bashTool } from '../src/tools/bash.js';
import type { SandboxConfig } from '../src/config/config.js';
import type { ToolContext } from '../src/tools/types.js';

const CFG_ON: SandboxConfig = { bash: 'on', allowNetwork: false, extraWritePaths: [] };
const CFG_OFF: SandboxConfig = { bash: 'off', allowNetwork: false, extraWritePaths: [] };

describe('buildSeatbeltProfile', () => {
  it('denies writes by default and allows the policy paths plus temp dirs', () => {
    const p = buildSeatbeltProfile({ writePaths: ['/work/proj'], allowNetwork: false });
    expect(p).toContain('(version 1)');
    expect(p).toContain('(allow default)');
    expect(p).toContain('(deny file-write*)');
    expect(p).toContain('(subpath "/work/proj")');
    expect(p).toContain('(subpath "/private/tmp")');
    expect(p).toContain('(subpath "/private/var/folders")');
    expect(p).toContain('(literal "/dev/null")');
  });

  it('toggles the network rule', () => {
    expect(buildSeatbeltProfile({ writePaths: [], allowNetwork: false })).toContain('(deny network*)');
    expect(buildSeatbeltProfile({ writePaths: [], allowNetwork: true })).not.toContain('(deny network*)');
  });

  it('escapes quotes and backslashes in paths', () => {
    const p = buildSeatbeltProfile({ writePaths: ['/we"ird\\dir'], allowNetwork: true });
    expect(p).toContain('(subpath "/we\\"ird\\\\dir")');
  });

  it('adds the realpath of write paths (symlinked cwd still matches)', () => {
    const link = path.join(os.tmpdir(), `sb-link-${process.pid}`);
    const real = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-real-'));
    try {
      fs.symlinkSync(real, link);
      const p = buildSeatbeltProfile({ writePaths: [link], allowNetwork: true });
      expect(p).toContain(`(subpath "${link}")`);
      expect(p).toContain(`(subpath "${fs.realpathSync(real)}")`);
    } finally {
      fs.rmSync(link, { force: true });
      fs.rmSync(real, { recursive: true, force: true });
    }
  });
});

describe('wrapCommand / sessionSandbox', () => {
  it('wraps via sandbox-exec with the same /bin/sh -c the shell path uses', () => {
    const w = wrapCommand('echo "hi" | wc -l', 'PROFILE');
    expect(w.file).toBe('/usr/bin/sandbox-exec');
    expect(w.args).toEqual(['-p', 'PROFILE', '/bin/sh', '-c', 'echo "hi" | wc -l']);
  });

  it('is off when config says off, on when forced even if config says off', () => {
    expect(sessionSandbox('/w', CFG_OFF)).toBeUndefined();
    if (!sandboxAvailable()) return; // platform without Seatbelt
    expect(sessionSandbox('/w', CFG_ON)?.profile).toContain('(deny file-write*)');
    const forced = sessionSandbox('/w', CFG_OFF, true);
    expect(forced?.forced).toBe(true);
  });
});

// Real-isolation tests: only meaningful where sandbox-exec exists.
describe.skipIf(!sandboxAvailable())('sandboxed Bash (darwin integration)', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-cwd-'));
  // A directory OUTSIDE every allowed write path: tmpdirs are allowed, so
  // use a scratch dir in the user's home.
  const outside = fs.mkdtempSync(path.join(os.homedir(), '.sb-outside-'));
  afterAll(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  const ctx = (force = false): ToolContext => ({
    cwd,
    readFiles: new Map(),
    sandbox: sessionSandbox(cwd, CFG_ON, force),
  });

  it('allows writes inside the working directory', async () => {
    const r = await bashTool.call({ command: `echo data > ${cwd}/in.txt` }, ctx());
    expect(r.output).toContain('exit code 0');
    expect(fs.existsSync(path.join(cwd, 'in.txt'))).toBe(true);
    expect(r.display).toContain('sandboxed');
  });

  it('blocks writes outside and appends the escalation reminder', async () => {
    const r = await bashTool.call({ command: `echo x > ${outside}/out.txt` }, ctx());
    expect(fs.existsSync(path.join(outside, 'out.txt'))).toBe(false);
    expect(r.output).toMatch(/Operation not permitted/i);
    expect(r.output).toContain('unsandboxed: true');
  });

  it('blocks network access', async () => {
    const r = await bashTool.call(
      { command: 'curl -sS -m 3 https://example.com && echo REACHED' },
      ctx(),
    );
    expect(r.output).not.toContain('REACHED');
  });

  it('unsandboxed: true bypasses the sandbox after approval', async () => {
    const r = await bashTool.call({ command: `echo y > ${outside}/esc.txt`, unsandboxed: true }, ctx());
    expect(r.output).toContain('exit code 0');
    expect(fs.existsSync(path.join(outside, 'esc.txt'))).toBe(true);
    expect(r.display).not.toContain('sandboxed');
  });

  it('forced sandbox ignores the unsandboxed flag and says the limit is fixed', async () => {
    const r = await bashTool.call({ command: `echo z > ${outside}/forced.txt`, unsandboxed: true }, ctx(true));
    expect(fs.existsSync(path.join(outside, 'forced.txt'))).toBe(false);
    expect(r.output).toContain('mandatory sandbox');
  });

  it('everyday commands still work: git init + pipeline in cwd', async () => {
    const r = await bashTool.call({ command: `cd ${cwd} && git init -q repo && ls | wc -l` }, ctx());
    expect(r.output).toContain('exit code 0');
  });
});

describe('bashTool sandbox metadata', () => {
  const base: ToolContext = { cwd: '/w', readFiles: new Map() };

  it('summarize tags unsandboxed calls for the approval prompt', () => {
    expect(bashTool.summarize({ command: 'ls', unsandboxed: true }, base)).toContain('[unsandboxed]');
    expect(bashTool.summarize({ command: 'ls' }, base)).not.toContain('[unsandboxed]');
  });

  it('riskOf raises read to mutate when unsandboxed', () => {
    expect(bashTool.riskOf({ command: 'ls' })).toBe('read');
    expect(bashTool.riskOf({ command: 'ls', unsandboxed: true })).toBe('mutate');
    expect(bashTool.riskOf({ command: 'rm -rf x', unsandboxed: true })).toBe('destructive');
  });

  it('sandboxedRun reflects ctx, bypass, and force', () => {
    const sandbox = { profile: 'P' };
    expect(bashTool.sandboxedRun!({ command: 'ls' }, base)).toBe(false);
    expect(bashTool.sandboxedRun!({ command: 'ls' }, { ...base, sandbox })).toBe(true);
    expect(bashTool.sandboxedRun!({ command: 'ls', unsandboxed: true }, { ...base, sandbox })).toBe(false);
    expect(
      bashTool.sandboxedRun!({ command: 'ls', unsandboxed: true }, { ...base, sandbox: { profile: 'P', forced: true } }),
    ).toBe(true);
  });
});
