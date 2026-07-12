import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CONFIG_FILENAME, effectiveMcpServers, loadConfig } from '../src/config/config.js';

const tmpDirs: string[] = [];

function dirWithConfig(config: object): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-config-'));
  tmpDirs.push(dir);
  fs.writeFileSync(path.join(dir, CONFIG_FILENAME), JSON.stringify(config));
  return dir;
}

afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe('loadConfig webFetch', () => {
  it('defaults to off', () => {
    expect(loadConfig(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-empty-'))).webFetch).toBe('off');
  });

  it('reads the mode from the config file', () => {
    expect(loadConfig(dirWithConfig({ webFetch: 'native' })).webFetch).toBe('native');
    expect(loadConfig(dirWithConfig({ webFetch: 'mcp' })).webFetch).toBe('mcp');
  });

  it('rejects unknown modes', () => {
    expect(() => loadConfig(dirWithConfig({ webFetch: 'always' }))).toThrow(/invalid webFetch/);
  });
});

describe('loadConfig sandbox', () => {
  it('defaults to off with no network and no extra paths', () => {
    const c = loadConfig(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-empty-')));
    expect(c.sandbox).toEqual({ bash: 'off', allowNetwork: false, extraWritePaths: [] });
  });

  it('merges partial sandbox config over defaults', () => {
    const c = loadConfig(dirWithConfig({ sandbox: { bash: 'on' } }));
    expect(c.sandbox.bash).toBe('on');
    expect(c.sandbox.allowNetwork).toBe(false);
  });

  it('rejects unknown sandbox.bash values', () => {
    expect(() => loadConfig(dirWithConfig({ sandbox: { bash: 'always' } }))).toThrow(/invalid sandbox.bash/);
  });
});

describe('effectiveMcpServers', () => {
  it('returns only user servers when webFetch is off or native', () => {
    const off = loadConfig(dirWithConfig({ mcpServers: { db: { command: 'x' } } }));
    expect(Object.keys(effectiveMcpServers(off))).toEqual(['db']);
    const native = loadConfig(dirWithConfig({ webFetch: 'native' }));
    expect(effectiveMcpServers(native)).toEqual({});
  });

  it('injects the default fetch server in mcp mode', () => {
    const config = loadConfig(dirWithConfig({ webFetch: 'mcp' }));
    const servers = effectiveMcpServers(config);
    expect(servers.fetch).toEqual({ command: 'uvx', args: ['mcp-server-fetch'] });
  });

  it('keeps a user-defined fetch server instead of the default', () => {
    const config = loadConfig(
      dirWithConfig({ webFetch: 'mcp', mcpServers: { fetch: { command: 'npx', args: ['my-fetch'] } } }),
    );
    expect(effectiveMcpServers(config).fetch).toEqual({ command: 'npx', args: ['my-fetch'] });
  });

  it('merges the injected server with other user servers', () => {
    const config = loadConfig(dirWithConfig({ webFetch: 'mcp', mcpServers: { db: { command: 'x' } } }));
    expect(Object.keys(effectiveMcpServers(config)).sort()).toEqual(['db', 'fetch']);
  });
});
