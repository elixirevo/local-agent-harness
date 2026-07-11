import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../src/providers/types.js';
import { listSessions, loadSession, newSessionId, SessionStore } from '../src/session/store.js';
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

describe('listSessions', () => {
  const msgs = (n: number): ChatMessage[] =>
    Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` }) as ChatMessage);

  it('returns saved sessions newest first with meta and message counts', () => {
    const { dir } = tmpCtx();
    expect(listSessions(dir)).toEqual([]); // no directory yet

    const a = new SessionStore({ id: '20260101-000000-aaaa', createdAt: 't1', provider: 'ollama', model: 'm1', cwd: dir });
    a.append(msgs(2));
    const b = new SessionStore({ id: '20260102-000000-bbbb', createdAt: 't2', provider: 'ollama', model: 'm2', cwd: dir });
    b.append(msgs(5));

    const list = listSessions(dir);
    expect(list.map((s) => s.id)).toEqual(['20260102-000000-bbbb', '20260101-000000-aaaa']);
    expect(list[0].messages).toBe(5);
    expect(list[0].model).toBe('m2');
    expect(list[0].firstPrompt).toBe('m0'); // msgs() starts with a user message
    expect(list[1].file.endsWith('20260101-000000-aaaa.jsonl')).toBe(true);
  });

  it('extracts the first typed prompt, skipping reminder blocks and system messages', () => {
    const { dir } = tmpCtx();
    const store = new SessionStore({ id: '20260104-000000-prev', createdAt: 't', provider: 'p', model: 'm', cwd: dir });
    store.append([
      { role: 'system', content: 'you are an agent' },
      {
        role: 'user',
        content: '<system-reminder>\ninjected startup context\n</system-reminder>\n\nFix the failing test\nin src/calc.js',
      },
      { role: 'assistant', content: 'ok' },
    ] as ChatMessage[]);
    const [s] = listSessions(dir);
    expect(s.firstPrompt).toBe('Fix the failing test'); // stripped + first line only
    expect(s.messages).toBe(3);
  });

  it('leaves firstPrompt empty when no user message has typed text', () => {
    const { dir } = tmpCtx();
    const store = new SessionStore({ id: '20260105-000000-none', createdAt: 't', provider: 'p', model: 'm', cwd: dir });
    store.append([
      { role: 'system', content: 'sys' },
      { role: 'user', content: '<system-reminder>only injected context</system-reminder>' },
    ] as ChatMessage[]);
    expect(listSessions(dir)[0].firstPrompt).toBe('');
  });

  it('skips unreadable files instead of failing the listing', () => {
    const { dir } = tmpCtx();
    const good = new SessionStore({ id: '20260103-000000-good', createdAt: 't', provider: 'p', model: 'm', cwd: dir });
    good.append(msgs(1));
    fs.writeFileSync(path.join(dir, '.harness/sessions', 'broken.jsonl'), 'not json\n', 'utf8');
    const list = listSessions(dir);
    expect(list.map((s) => s.id)).toEqual(['20260103-000000-good']);
  });
});
