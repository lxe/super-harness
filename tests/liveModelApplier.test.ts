import { describe, expect, it, vi } from 'vitest';
import { LiveModelApplier } from '../src/main/services/liveModelApplier';
import type { SessionConfigChange, UnifiedSession } from '../src/shared/types';

function tmuxSession(overrides: Partial<UnifiedSession> = {}): UnifiedSession {
  return {
    id: 'claude:a',
    nativeId: 'a',
    harness: 'claude-tmux',
    harnessGroup: 'claude',
    title: 't',
    preview: '',
    cwd: '/tmp',
    projectName: 'tmp',
    status: 'idle',
    isLive: true,
    isRemote: false,
    createdAt: 1,
    updatedAt: 2,
    pinned: false,
    folderId: null,
    tags: [],
    hidden: false,
    dispatchMode: 'tmux-send',
    tmuxTarget: 'sh-x:0.0',
    ...overrides,
  } as UnifiedSession;
}

function setup(session: UnifiedSession | undefined) {
  const state = { session };
  const apply = vi.fn(async (id: string, _change: SessionConfigChange) => ({ ok: true, sessionId: id, results: [] }));
  const applier = new LiveModelApplier({ getSession: () => state.session, apply, retryMs: 5 });
  return { state, apply, applier };
}

describe('LiveModelApplier', () => {
  it('restarts an idle terminal Claude with the picked model and effort', async () => {
    const { apply, applier } = setup(tmuxSession());
    applier.note([{ type: 'set_model', sessionId: 'claude:a', model: 'opus', reasoningEffort: 'medium' }]);
    await applier.flush();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith('claude:a', { model: 'opus', reasoningEffort: 'medium', restart: true });
    expect(applier.pendingSessionIds()).toEqual([]);
    applier.dispose();
  });

  it('waits while Claude is mid-turn and applies the latest pick once it is idle', async () => {
    const { state, apply, applier } = setup(tmuxSession({ status: 'running' }));
    applier.note([{ type: 'set_model', sessionId: 'claude:a', model: 'sonnet' }]);
    applier.note([{ type: 'set_model', sessionId: 'claude:a', model: 'opus' }]);
    await applier.flush();
    expect(apply).not.toHaveBeenCalled();
    expect(applier.pendingSessionIds()).toEqual(['claude:a']);

    state.session = tmuxSession({ status: 'idle' });
    await applier.flush();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith('claude:a', { model: 'opus', restart: true });
    applier.dispose();
  });

  it('ignores sessions that are not a terminal Claude, and other actions', async () => {
    const { apply, applier } = setup(tmuxSession({ harness: 'claude', dispatchMode: 'claude-print', tmuxTarget: undefined }));
    applier.note([
      { type: 'set_model', sessionId: 'claude:a', model: 'opus' },
      { type: 'pin', sessionId: 'claude:a' },
    ]);
    await applier.flush();
    expect(apply).not.toHaveBeenCalled();
    expect(applier.pendingSessionIds()).toEqual([]);
    applier.dispose();
  });

  it('never applies stored choices on its own: nothing happens without a pick', async () => {
    const { apply, applier } = setup(tmuxSession({ model: 'opus' }));
    await applier.flush();
    expect(apply).not.toHaveBeenCalled();
    applier.dispose();
  });
});
