import { describe, expect, it } from 'vitest';
import { shouldDismissPopover } from '../src/renderer/ui/Menu';

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
