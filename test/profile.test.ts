import { describe, expect, it } from 'vitest';
import { resolveProfile } from '../src/models/profile.js';

describe('resolveProfile', () => {
  it('matches Ollama-style ids', () => {
    expect(resolveProfile('qwen3:32b').family).toBe('qwen3');
    expect(resolveProfile('llama3.2:3b').family).toBe('llama3');
    expect(resolveProfile('deepseek-r1:14b').family).toBe('deepseek-r1');
    expect(resolveProfile('gemma4:e2b').family).toBe('gemma4');
    expect(resolveProfile('gemma3:4b').family).toBe('gemma');
    expect(resolveProfile('kimi-k2.5:latest').family).toBe('kimi-k2');
  });

  it('matches HF-style ids by basename', () => {
    expect(resolveProfile('Qwen/Qwen3-32B').family).toBe('qwen3');
    expect(resolveProfile('meta-llama/Llama-3.3-70B-Instruct').family).toBe('llama3');
  });

  it('falls back to conservative defaults for unknown models', () => {
    const p = resolveProfile('mystery-model-9000');
    expect(p.family).toBe('unknown');
    expect(p.nativeToolCalls).toBe(false);
    expect(p.promptTier).toBe('minimal');
    expect(p.modelId).toBe('mystery-model-9000');
  });

  it('applies config overrides, exact id taking precedence over family', () => {
    const overrides = {
      qwen3: { temperature: 0.1, contextLength: 2 },
      'qwen3:32b': { contextLength: 1 },
    };
    expect(resolveProfile('qwen3:32b', overrides).contextLength).toBe(1);
    expect(resolveProfile('qwen3:8b', overrides).contextLength).toBe(2);
    expect(resolveProfile('qwen3:8b', overrides).temperature).toBe(0.1);
  });
});
