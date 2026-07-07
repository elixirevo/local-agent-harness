import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../src/providers/types.js';
import { loadSession, newSessionId, SessionStore } from '../src/session/store.js';
import { tmpCtx } from './toolHelpers.js';

describe('SessionStore', () => {
  const msgs = (n: number): ChatMessage[] =>
    Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` }) as ChatMessage);

  it('appends incrementally and loads back meta + messages', () => {
    const { dir } = tmpCtx();
    const meta = { id: newSessionId(), createdAt: 'now', provider: 'ollama', model: 'm', cwd: dir };
    const store = new SessionStore(meta);
    store.append(msgs(2));
    store.append(msgs(4)); // two new messages
    const loaded = loadSession(dir, meta.id);
    expect(loaded.messages).toHaveLength(4);
    expect(loaded.messages[3].content).toBe('m3');
    expect(loaded.meta.model).toBe('m');

    // resume-style continuation appends to the same file
    const resumed = new SessionStore(loaded.meta);
    resumed.markSaved(loaded.messages.length);
    resumed.append([...msgs(4), { role: 'user', content: 'new turn' }]);
    expect(loadSession(dir, 'last').messages).toHaveLength(5);
  });

  it('does not double-write already-saved messages', () => {
    const { dir } = tmpCtx();
    const meta = { id: newSessionId(), createdAt: 'now', provider: 'p', model: 'm', cwd: dir };
    const store = new SessionStore(meta);
    store.append(msgs(3));
    store.append(msgs(3)); // no-op
    const lines = fs.readFileSync(path.join(dir, '.harness/sessions', `${meta.id}.jsonl`), 'utf8')
      .split('\n')
      .filter(Boolean);
    expect(lines).toHaveLength(4); // 1 meta + 3 messages
  });

  it('tolerates a torn trailing line when loading', () => {
    const { dir } = tmpCtx();
    const meta = { id: newSessionId(), createdAt: 'now', provider: 'p', model: 'm', cwd: dir };
    const store = new SessionStore(meta);
    store.append(msgs(2));
    const file = path.join(dir, '.harness/sessions', `${meta.id}.jsonl`);
    fs.appendFileSync(file, '{"type":"message","mess'); // simulated crash mid-write
    expect(loadSession(dir, meta.id).messages).toHaveLength(2);
  });

  it('fails clearly when nothing exists to resume', () => {
    const { dir } = tmpCtx();
    expect(() => loadSession(dir, 'last')).toThrow(/no saved sessions/);
    expect(() => loadSession(dir, 'nope')).toThrow(/session not found/);
  });

  it('records compaction: load returns rebuilt state, file keeps full history', () => {
    const { dir } = tmpCtx();
    const meta = { id: newSessionId(), createdAt: 'now', provider: 'p', model: 'm', cwd: dir };
    const store = new SessionStore(meta);
    store.append(msgs(6));
    const rebuilt: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'summary + continuation' },
    ];
    store.recordCompaction(rebuilt);

    const loaded = loadSession(dir, meta.id);
    expect(loaded.messages).toHaveLength(2);
    expect(loaded.messages[1].content).toBe('summary + continuation');

    // pre-compaction lines remain as the full-transcript escape hatch
    const raw = fs.readFileSync(path.join(dir, '.harness/sessions', `${meta.id}.jsonl`), 'utf8');
    expect(raw).toContain('m5');
    expect(raw).toContain('"type":"compact"');

    // post-compaction turns keep appending normally
    store.append([...rebuilt, { role: 'assistant', content: 'next answer' }]);
    expect(loadSession(dir, meta.id).messages).toHaveLength(3);
  });
});
