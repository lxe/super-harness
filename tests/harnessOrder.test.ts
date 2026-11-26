import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HARNESS_ORDER,
  groupSessionsForSidebar,
  moveHarness,
  normalizeHarnessOrder,
} from '../src/renderer/utils/sidebarGrouping';
import type { UnifiedSession } from '../src/shared/types';

describe('harness order', () => {
  it('completes a saved order and ignores junk', () => {
    expect(normalizeHarnessOrder(undefined)).toEqual(DEFAULT_HARNESS_ORDER);
    expect(normalizeHarnessOrder(['claude', 'bogus', 'claude', 'codex'])).toEqual(['claude', 'codex', 'antigravity', 'muse']);
  });
  it('moves a dragged harness onto the target position', () => {
    expect(moveHarness([], 'muse', 'antigravity')).toEqual(['muse', 'antigravity', 'codex', 'claude']);
    expect(moveHarness(['antigravity', 'codex', 'claude', 'muse'], 'antigravity', 'claude')).toEqual(['codex', 'claude', 'antigravity', 'muse']);
    expect(moveHarness(['codex'], 'codex', 'codex')).toEqual(['codex', 'antigravity', 'claude', 'muse']);
  });
  it('orders the All view harness sections by the saved order', () => {
    const s = (id: string, g: string) =>
      ({ id, harnessGroup: g, harness: g, updatedAt: 1, tags: [], title: id }) as unknown as UnifiedSession;
    const sessions = [s('a', 'antigravity'), s('b', 'codex'), s('c', 'claude'), s('d', 'muse')];
    const groups = groupSessionsForSidebar(sessions, 'native', [], 'all', ['muse', 'claude']);
    expect(groups.map((g) => g.id)).toEqual(['harness:muse', 'harness:claude', 'harness:antigravity', 'harness:codex']);
  });
});
