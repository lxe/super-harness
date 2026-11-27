import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('unread bookkeeping', () => {
  it('baseline hides old activity; read marks advance; mark unread forces the dot', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-unread-'));
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    vi.resetModules();
    const { ConfigStore } = await import('../src/main/store/configStore');
    const store = new (ConfigStore as unknown as new () => InstanceType<typeof ConfigStore>)();
    const base = store.getReadMark('claude:a');
    expect(base).toBeGreaterThan(Date.now() - 60_000); // fresh install: baseline is now
    expect(store.markRead([{ sessionId: 'claude:a', updatedAt: base + 5000 }])).toBe(true);
    expect(store.getReadMark('claude:a')).toBe(base + 5000);
    expect(store.markRead([{ sessionId: 'claude:a', updatedAt: base + 10 }])).toBe(false); // never goes back
    store.markUnread('claude:a');
    expect(store.getReadMark('claude:a')).toBe(-1);
    expect(store.markRead([{ sessionId: 'claude:a', updatedAt: base + 1 }])).toBe(true); // opening clears it
    vi.restoreAllMocks();
  });

  it('readLastClaudeMessageMs ignores trailing idle metadata flushes so old Claude threads do not re-trigger unread', async () => {
    const { readLastClaudeMessageMs } = await import('../src/main/adapters/claudeAdapter');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-claude-ts-'));
    const file = path.join(dir, 'sess.jsonl');
    const realIso = '2026-11-26T14:58:55.286Z';
    const expectedMs = Date.parse(realIso);
    const lines = [
      JSON.stringify({ type: 'user', timestamp: '2026-11-26T14:58:00.000Z', message: { role: 'user', content: 'hi' } }),
      JSON.stringify({ type: 'assistant', timestamp: realIso, message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } }),
      JSON.stringify({ type: 'permission-mode', permissionMode: 'bypassPermissions' }),
      JSON.stringify({ type: 'session-owner', pid: 1234 }),
      JSON.stringify({ type: 'atis-latch' }),
      JSON.stringify({ type: 'bridge-session', bridgeSessionId: 'b1' }),
      JSON.stringify({ type: 'cost-state', totalCostUsd: 1.23 }),
    ];
    fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
    expect(readLastClaudeMessageMs(file)).toBe(expectedMs);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
