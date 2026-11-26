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
});
