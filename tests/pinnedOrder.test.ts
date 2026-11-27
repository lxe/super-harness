import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

describe('settings.pinnedOrder', () => {
  it('keeps string ids once each, in the order given', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-home-'));
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    try {
      vi.resetModules();
      const { ConfigStore } = await import('../src/main/store/configStore');
      const store = new ConfigStore();
      const state = store.updateSettings({
        pinnedOrder: ['claude:b', 'codex:a', 'claude:b', '', 42 as unknown as string],
      });
      expect(state.settings.pinnedOrder).toEqual(['claude:b', 'codex:a']);
      expect(store.updateSettings({ pinnedOrder: 'x' as unknown as string[] }).settings.pinnedOrder).toEqual([]);
    } finally {
      process.env.HOME = prevHome;
      vi.resetModules();
    }
  });
});
