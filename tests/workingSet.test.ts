import { describe, expect, it } from 'vitest';
import { staleWorkingIds } from '../src/main/utils/workingSet';

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
