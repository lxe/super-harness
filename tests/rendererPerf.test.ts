import { describe, expect, it, vi } from 'vitest';
import type { SessionTranscriptResult, UnifiedBlock } from '../src/shared/types';
import {
  clearMarkdownCache,
  getMarkdownCacheSize,
  renderMarkdownHtml,
} from '../src/renderer/utils/format';
import {
  isTranscriptEquivalent,
  RendererTranscriptCache,
} from '../src/renderer/utils/transcriptCache';
import { segmentBlocks } from '../src/renderer/components/CoalescedBlockView';

function makeRes(
  sessionId: string,
  count: number,
  overrides?: Partial<SessionTranscriptResult>
): SessionTranscriptResult {
  return {
    sessionId,
    messages: Array.from({ length: count }, (_, i) => ({
      id: `m-${i}`,
      role: i % 2 === 0 ? 'user' : 'assistant',
      timestamp: 1000 + i,
      blocks: [{ type: 'text', text: `msg ${i}` }],
    })),
    totalCount: count,
    hasMore: false,
    sourceMtimeMs: 5000,
    ...overrides,
  };
}

describe('RendererTranscriptCache', () => {
  it('hydrates cached sessions in O(1), promotes MRU, and evicts LRU', () => {
    const cache = new RendererTranscriptCache(4);
    for (let i = 1; i <= 4; i++) {
      cache.set(`s${i}`, makeRes(`s${i}`, 5), 40);
    }
    // Promote s1
    expect(cache.get('s1')?.result.sessionId).toBe('s1');
    // Insert s5 -> s2 evicted
    cache.set('s5', makeRes('s5', 5), 40);
    expect(cache.has('s2')).toBe(false);
    expect(cache.has('s1')).toBe(true);
    expect(cache.size()).toBe(4);
  });

  it('deduplicates concurrent prefetches and skips master/draft sessions', async () => {
    const cache = new RendererTranscriptCache(8);
    const fetcher = vi.fn(async (id: string) => makeRes(id, 10));

    expect(await cache.prefetch('master:root', fetcher)).toBeNull();
    expect(await cache.prefetch('draft:123', fetcher)).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();

    const [a, b, c] = await Promise.all([
      cache.prefetch('codex:1', fetcher, 40),
      cache.prefetch('codex:1', fetcher, 40),
      cache.prefetch('codex:1', fetcher, 40),
    ]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(a?.sessionId).toBe('codex:1');
    expect(b).toBe(a);
    expect(c).toBe(a);

    // Subsequent fresh prefetch hits memory cache without calling fetcher
    await cache.prefetch('codex:1', fetcher, 40);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('detects real transcript differences cleanly via isTranscriptEquivalent', () => {
    const a = makeRes('s1', 5, { liveActivity: { isWorking: false, lastEventAt: 5000 } });
    const same = makeRes('s1', 5, { liveActivity: { isWorking: false, lastEventAt: 5000 } });
    expect(isTranscriptEquivalent(a, same)).toBe(true);

    // Changed mtime
    expect(isTranscriptEquivalent(a, { ...same, sourceMtimeMs: 6000 })).toBe(false);
    // Changed working state
    expect(
      isTranscriptEquivalent(a, { ...same, liveActivity: { isWorking: true, lastEventAt: 5000 } })
    ).toBe(false);
    // Changed queued messages
    expect(
      isTranscriptEquivalent(a, {
        ...same,
        liveActivity: {
          isWorking: false,
          lastEventAt: 5000,
          queuedMessages: [{ id: 'q1', text: 'next', createdAt: 1, source: 'native' }],
        },
      })
    ).toBe(false);
    // Added block to last message
    const extended = makeRes('s1', 5, { liveActivity: { isWorking: false, lastEventAt: 5000 } });
    extended.messages[4].blocks.push({ type: 'text', text: 'more' });
    expect(isTranscriptEquivalent(a, extended)).toBe(false);
  });
});

describe('renderMarkdownHtml LRU cache', () => {
  it('caches parsed markdown, strips script tags, and bounds cache size', () => {
    clearMarkdownCache();
    expect(getMarkdownCacheSize()).toBe(0);

    const md = '# Heading\n\nHello **world** <script>alert(1)</script>';
    const html1 = renderMarkdownHtml(md);
    expect(html1).toContain('<h1>Heading</h1>');
    expect(html1).toContain('<strong>world</strong>');
    expect(html1).not.toContain('<script>');
    expect(getMarkdownCacheSize()).toBe(1);

    const html2 = renderMarkdownHtml(md);
    expect(html2).toBe(html1);
    expect(getMarkdownCacheSize()).toBe(1);

    // Insert 650 unique entries -> bounded at 600
    for (let i = 0; i < 650; i++) {
      renderMarkdownHtml(`Item **${i}**`);
    }
    expect(getMarkdownCacheSize()).toBeLessThanOrEqual(600);
  });
});

describe('segmentBlocks', () => {
  it('coalesces consecutive trace blocks while keeping text, image, and question standalone', () => {
    const blocks: UnifiedBlock[] = [
      { type: 'thinking', text: 'plan' },
      { type: 'command', command: 'ls' },
      { type: 'file_change', changes: [{ path: 'a.ts', kind: 'edit' }] },
      { type: 'text', text: 'Updated a.ts' },
      { type: 'tool_call', name: 'read_file' },
      { type: 'question', questions: [{ question: 'Ok?', options: ['Yes'] }] },
      { type: 'image', path: '/tmp/a.png' },
    ];

    const segs = segmentBlocks(blocks);
    expect(segs).toHaveLength(5);
    expect(segs[0].kind).toBe('trace');
    if (segs[0].kind === 'trace') expect(segs[0].blocks).toHaveLength(3);
    expect(segs[1]).toMatchObject({ kind: 'single', block: { type: 'text' } });
    expect(segs[2].kind).toBe('trace');
    if (segs[2].kind === 'trace') expect(segs[2].blocks).toHaveLength(1);
    expect(segs[3]).toMatchObject({ kind: 'single', block: { type: 'question' } });
    expect(segs[4]).toMatchObject({ kind: 'single', block: { type: 'image' } });
  });
});
