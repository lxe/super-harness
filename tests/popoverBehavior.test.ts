import { describe, expect, it } from 'vitest';
import { shouldDismissPopover } from '../src/renderer/ui/Menu';
import { computeRecencyVisual } from '../src/renderer/ui/RecencyClock';

function makeMockNode(children: Node[] = []): Node {
  const childSet = new Set(children);
  const node = {
    contains(other: Node | null): boolean {
      if (!other) return false;
      if (other === (node as unknown as Node)) return true;
      for (const c of childSet) {
        if (c === other || c.contains(other)) return true;
      }
      return false;
    },
  } as unknown as Node;
  return node;
}

describe('PopoverSurface click-outside dismissal contract', () => {
  it('keeps popover open when clicking inside the popover surface or on its trigger', () => {
    const insideItem = makeMockNode();
    const surface = makeMockNode([insideItem]);
    const triggerIcon = makeMockNode();
    const trigger = makeMockNode([triggerIcon]);

    expect(shouldDismissPopover(surface, surface, trigger)).toBe(false);
    expect(shouldDismissPopover(insideItem, surface, trigger)).toBe(false);
    expect(shouldDismissPopover(trigger, surface, trigger)).toBe(false);
    expect(shouldDismissPopover(triggerIcon, surface, trigger)).toBe(false);
  });

  it('dismisses popover when clicking anywhere outside the popover and trigger', () => {
    const surface = makeMockNode();
    const trigger = makeMockNode();
    const pageCanvas = makeMockNode();
    const composerTextarea = makeMockNode();

    expect(shouldDismissPopover(pageCanvas, surface, trigger)).toBe(true);
    expect(shouldDismissPopover(composerTextarea, surface, trigger)).toBe(true);
    expect(shouldDismissPopover(pageCanvas, surface, null)).toBe(true);
    expect(shouldDismissPopover(null, surface, trigger)).toBe(false);
  });
});

describe('RecencyClock freshness mapping', () => {
  it('increases clock hand angle and steps down color intensity as age grows', () => {
    const now = 1_795_652_000_000;
    const MIN = 60_000;
    const HR = 60 * MIN;
    const DAY = 24 * HR;

    const hot = computeRecencyVisual(now - 2 * MIN, now);
    const recent = computeRecencyVisual(now - 25 * MIN, now);
    const today = computeRecencyVisual(now - 3 * HR, now);
    const day = computeRecencyVisual(now - 12 * HR, now);
    const week = computeRecencyVisual(now - 3 * DAY, now);
    const stale = computeRecencyVisual(now - 14 * DAY, now);

    expect(hot.tier).toBe('hot');
    expect(hot.colorClass).toContain('emerald');
    expect(recent.tier).toBe('recent');
    expect(today.tier).toBe('today');
    expect(day.tier).toBe('day');
    expect(week.tier).toBe('week');
    expect(stale.tier).toBe('stale');

    // Hand angle monotonically sweeps clockwise with age
    expect(hot.angleDeg).toBeLessThan(recent.angleDeg);
    expect(recent.angleDeg).toBeLessThan(today.angleDeg);
    expect(today.angleDeg).toBeLessThan(day.angleDeg);
    expect(day.angleDeg).toBeLessThan(week.angleDeg);
    expect(week.angleDeg).toBeLessThan(stale.angleDeg);
  });
});
