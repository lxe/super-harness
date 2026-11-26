import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('orchestrator memory file', () => {
  it('round-trips and rejects oversized memory', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-orch-'));
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    vi.resetModules();
    const m = await import('../src/main/services/orchestratorMemory');
    expect(m.readOrchestratorMemory()).toContain("## What's going on");
    expect(m.writeOrchestratorMemory('# Memory\nline').ok).toBe(true);
    expect(fs.readFileSync(m.ORCHESTRATOR_MEMORY_PATH, 'utf8')).toBe('# Memory\nline\n');
    expect(m.writeOrchestratorMemory('x'.repeat(70 * 1024)).ok).toBe(false);
    vi.restoreAllMocks();
  });
});

describe('master thread bookkeeping in the store', () => {
  it('collects segment and legacy ids, and a cleared thread keeps hiding old ones', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-store-'));
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    vi.resetModules();
    const { ConfigStore } = await import('../src/main/store/configStore');
    const store = new (ConfigStore as unknown as new () => InstanceType<typeof ConfigStore>)();
    store.updateMasterThread((t) => ({
      ...t,
      segments: [{ engine: 'claude', nativeId: 'seg-1', startedAt: 1, turns: 2 }],
      legacyNativeIds: ['old-1'],
    }));
    expect([...store.getMasterNativeIds()].sort()).toEqual(['old-1', 'seg-1']);
    store.clearMasterMessages();
    expect(store.getMasterThread().segments).toEqual([]);
    expect([...store.getMasterNativeIds()].sort()).toEqual(['old-1', 'seg-1']);
    vi.restoreAllMocks();
  });
});
