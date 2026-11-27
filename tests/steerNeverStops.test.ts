import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { HarnessDispatcher } from '../src/main/services/dispatcher';
import type { SendMessageResult, UnifiedSession } from '../src/shared/types';

function session(status: UnifiedSession['status']): UnifiedSession {
  return {
    id: 'muse:a', nativeId: 'a', harness: 'muse', harnessGroup: 'muse', title: 't', preview: '',
    cwd: '/tmp', projectName: 'tmp', status, isLive: true, isRemote: false, createdAt: 1, updatedAt: 2,
    pinned: false, folderId: null, tags: [], hidden: false, dispatchMode: 'muse-msp',
  } as UnifiedSession;
}

describe('a steer never stops a running turn', () => {
  it('holds a message the harness cannot take mid-turn and sends it once the turn ends', async () => {
    const state = { s: session('running') };
    const calls: Array<{ force?: boolean }> = [];
    const driver = {
      sendMessage: vi.fn(async (_s: UnifiedSession, _p: string, _a: unknown, _c: unknown, opts?: { force?: boolean }) => {
        calls.push({ force: opts?.force });
        const r: SendMessageResult = state.s.status === 'running'
          ? { ok: false, holdUntilIdle: true, error: 'mid-turn' }
          : { ok: true };
        return r;
      }),
    };
    const registry = {
      getSession: () => state.s,
      getDriver: () => driver,
      discover: async () => ({}),
    } as never;
    const d = new HarnessDispatcher(registry, {} as never, () => {}, () => {});

    const res = await d.sendToSession('muse:a', 'go left', undefined, { force: true });
    expect(res.ok).toBe(true);
    expect(res.dispatchedVia).toMatch(/held/);

    await d.flushHeld(); // still running: nothing sent
    expect(calls).toHaveLength(1);

    state.s = session('idle');
    await d.flushHeld(); // first idle check
    expect(calls).toHaveLength(1);
    await d.flushHeld(); // second idle check: sent as a normal message
    expect(calls).toHaveLength(2);
    expect(calls[1].force).toBe(false);
  });

  it('no adapter interrupts a turn to deliver a steer', () => {
    const src = (f: string) => fs.readFileSync(path.join(__dirname, '..', 'src', 'main', f), 'utf8');
    expect(src('adapters/claudeAdapter.ts')).not.toContain('opts?.force && streamPool.hasActiveTurn(session.id)');
    expect(src('adapters/codexAdapter.ts')).not.toMatch(/steerTurn[\s\S]{0,200}interruptTurn/);
    expect(src('adapters/museAdapter.ts')).not.toMatch(/steerTurn[\s\S]{0,300}interruptSession/);
    expect(src('services/agyAcpClient.ts')).not.toMatch(/if \(force\) \{\s*await this\.cancel/);
  });
});
