import { describe, expect, it } from 'vitest';
import { buildSystemPrompt, staticSections } from '../src/prompts/assemble.js';
import { defaultRegistry } from '../src/tools/registry.js';

const registry = defaultRegistry();
const base = { mode: 'ask' as const, registry };

describe('buildSystemPrompt', () => {
  it('grows monotonically across tiers', () => {
    const minimal = buildSystemPrompt({ ...base, tier: 'minimal', protocol: 'native', cwd: '/p' });
    const standard = buildSystemPrompt({ ...base, tier: 'standard', protocol: 'native', cwd: '/p' });
    const full = buildSystemPrompt({ ...base, tier: 'full', protocol: 'native', cwd: '/p' });
    expect(minimal.length).toBeLessThan(standard.length);
    expect(standard.length).toBeLessThan(full.length);
    expect(standard).toContain('# Using tools');
    expect(full).toContain('# Verification');
    expect(minimal).not.toContain('# Using tools');
  });

  it('keeps the static prefix byte-identical across sessions with different cwd', () => {
    const a = buildSystemPrompt({ ...base, tier: 'standard', protocol: 'native', cwd: '/project/a' });
    const b = buildSystemPrompt({ ...base, tier: 'standard', protocol: 'native', cwd: '/somewhere/else' });
    const staticPrefix = staticSections({ ...base, tier: 'standard', protocol: 'native', cwd: 'ignored' }).join('\n\n');
    expect(a.startsWith(staticPrefix)).toBe(true);
    expect(b.startsWith(staticPrefix)).toBe(true);
    expect(a).toContain('Working directory: /project/a');
  });

  it('places the dynamic environment section last', () => {
    const p = buildSystemPrompt({ ...base, tier: 'standard', protocol: 'text', cwd: '/p' });
    expect(p.indexOf('# Environment')).toBeGreaterThan(p.indexOf('# How to call tools'));
  });

  it('documents the text protocol with the mode-filtered tool list', () => {
    const ask = buildSystemPrompt({ ...base, tier: 'minimal', protocol: 'text', cwd: '/p' });
    expect(ask).toContain('<tool_call>');
    expect(ask).toContain('## Bash');
    const readonly = buildSystemPrompt({ tier: 'minimal', protocol: 'text', mode: 'readonly', registry, cwd: '/p' });
    expect(readonly).not.toContain('## Write');
    expect(readonly).not.toContain('## Bash');
    expect(readonly).toContain('## Read');
  });

  it('omits agent/tool sections entirely for protocol none', () => {
    const p = buildSystemPrompt({ ...base, tier: 'standard', protocol: 'none', cwd: '/p' });
    expect(p).not.toContain('# Using tools');
    expect(p).not.toContain('<tool_call>');
    expect(p).not.toContain('# Rules');
    expect(p).toContain('helpful assistant');
    expect(p).toContain('# Environment');
  });
});
