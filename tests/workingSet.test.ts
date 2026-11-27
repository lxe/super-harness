import { describe, expect, it } from 'vitest';
import { staleWorkingIds, WorkingCompletionTracker } from '../src/main/utils/workingSet';

describe('staleWorkingIds', () => {
  const base = { now: 100_000, graceMs: 15_000 };
  it('drops an unwatched session that discovery sees idle, after the grace period', () => {
    expect(staleWorkingIds({ ...base, working: ['a'], addedAt: new Map([['a', 10_000]]), watched: new Set(), discoveredRunning: () => false })).toEqual(['a']);
  });
  it('keeps a session someone is watching (its live transcript decides)', () => {
    expect(staleWorkingIds({ ...base, working: ['a'], addedAt: new Map([['a', 10_000]]), watched: new Set(['a']), discoveredRunning: () => false })).toEqual([]);
  });
  it('keeps a just-sent message inside the grace period, before the agent shows activity', () => {
    expect(staleWorkingIds({ ...base, working: ['a'], addedAt: new Map([['a', 95_000]]), watched: new Set(), discoveredRunning: () => false })).toEqual([]);
  });
  it('keeps sessions discovery still sees running, or does not know', () => {
    expect(staleWorkingIds({ ...base, working: ['a', 'b'], addedAt: new Map(), watched: new Set(), discoveredRunning: (id) => (id === 'a' ? true : undefined) })).toEqual([]);
  });
});

describe('WorkingCompletionTracker', () => {
  it('fires completion when a session marked working on send finishes after >= 2s', () => {
    const tracker = new WorkingCompletionTracker();
    tracker.markWorking('antigravity:s1', 10_000);
    // Repeated markWorking from transcript poll preserves original start time
    tracker.markWorking('antigravity:s1', 15_000);
    expect(tracker.markIdleAndCheckCompleted('antigravity:s1', 16_000)).toBe(true);
    // Subsequent reconcile does not double-fire
    expect(
      tracker.reconcileDiscovery({
        runningIds: [],
        knownIds: new Set(['antigravity:s1']),
        now: 17_000,
      })
    ).toEqual([]);
  });

  it('fires completion for unwatched sessions transitioning running -> idle in discovery', () => {
    const tracker = new WorkingCompletionTracker();
    // Already-idle sessions on startup are ignored; running session is tracked
    expect(
      tracker.reconcileDiscovery({
        runningIds: ['claude:s2'],
        knownIds: new Set(['claude:s2', 'claude:idle']),
        now: 100_000,
      })
    ).toEqual([]);
    // Transitions to idle 5s later -> triggers completion push
    expect(
      tracker.reconcileDiscovery({
        runningIds: [],
        knownIds: new Set(['claude:s2', 'claude:idle']),
        now: 105_000,
      })
    ).toEqual(['claude:s2']);
  });

  it('suppresses short blips (< 2s), master sessions, and disappeared sessions', () => {
    const tracker = new WorkingCompletionTracker();
    tracker.markWorking('master:root', 10_000);
    expect(tracker.markIdleAndCheckCompleted('master:root', 20_000)).toBe(false);

    tracker.markWorking('codex:blip', 10_000);
    expect(tracker.markIdleAndCheckCompleted('codex:blip', 11_000)).toBe(false);

    tracker.markWorking('muse:gone', 10_000);
    expect(
      tracker.reconcileDiscovery({
        runningIds: [],
        knownIds: new Set(),
        now: 20_000,
      })
    ).toEqual([]);
    expect(tracker.has('muse:gone')).toBe(false);
  });
});
