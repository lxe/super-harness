import { describe, expect, it, vi } from 'vitest';
import type { SessionTranscriptResult } from '../src/shared/types';
import { TranscriptCache } from '../src/main/services/transcriptCache';

function makeTranscript(
  sessionId: string,
  count: number,
  opts?: { hasMore?: boolean; totalCount?: number; payloadSize?: number }
): SessionTranscriptResult {
  const pad = 'a'.repeat(opts?.payloadSize ?? 20);
  return {
    sessionId,
    messages: Array.from({ length: count }, (_, i) => ({
      id: `${sessionId}-m-${i}`,
      role: i % 2 === 0 ? 'user' : 'assistant',
      timestamp: 1000 + i,
      blocks: [{ type: 'text', text: `msg ${i} ${pad}` }],
    })),
    totalCount: opts?.totalCount ?? count,
    hasMore: opts?.hasMore ?? false,
    sourceMtimeMs: 123456,
  };
}

describe('TranscriptCache', () => {
  it('returns cache hits on matching fingerprint and slices when requestedLimit is smaller', () => {
    const cache = new TranscriptCache({ maxEntries: 10 });
    const full = makeTranscript('s1', 40, { hasMore: true, totalCount: 100 });
    cache.set('s1', 'fp-1', 40, full);

    const exact = cache.get('s1', 'fp-1', 40);
    expect(exact).toBe(full);

    const smaller = cache.get('s1', 'fp-1', 15);
    expect(smaller).not.toBeNull();
    expect(smaller!.messages).toHaveLength(15);
    expect(smaller!.messages[0].id).toBe('s1-m-25');
    expect(smaller!.messages[14].id).toBe('s1-m-39');
    expect(smaller!.hasMore).toBe(true);
    // Original cached entry must not be mutated
    expect(full.messages).toHaveLength(40);
  });

  it('misses when fingerprint changes or when larger limit is needed with hasMore=true', () => {
    const cache = new TranscriptCache({ maxEntries: 10 });
    cache.set('s1', 'fp-1', 40, makeTranscript('s1', 40, { hasMore: true, totalCount: 100 }));

    // Fingerprint mismatch (file modified)
    expect(cache.get('s1', 'fp-2', 40)).toBeNull();
    // Requesting more messages when more exist on disk
    expect(cache.get('s1', 'fp-1', 80)).toBeNull();

    // When hasMore=false (entire transcript already loaded), larger limit STILL hits!
    cache.set('s2', 'fp-s2', 40, makeTranscript('s2', 12, { hasMore: false, totalCount: 12 }));
    const hit = cache.get('s2', 'fp-s2', 120);
    expect(hit).not.toBeNull();
    expect(hit!.messages).toHaveLength(12);
  });

  it('evicts least-recently-used entries when maxEntries or byte budget is exceeded', () => {
    const cache = new TranscriptCache({ maxEntries: 4 });
    for (let i = 1; i <= 4; i++) {
      cache.set(`s${i}`, 'fp', 10, makeTranscript(`s${i}`, 5));
    }
    // Touch s1 so s2 becomes the LRU entry
    expect(cache.get('s1', 'fp', 10)).not.toBeNull();

    // Insert s5 -> s2 should be evicted, s1 kept
    cache.set('s5', 'fp', 10, makeTranscript('s5', 5));
    expect(cache.get('s2', 'fp', 10)).toBeNull();
    expect(cache.get('s1', 'fp', 10)).not.toBeNull();
    expect(cache.stats().entries).toBe(4);

    // Byte-budget eviction
    const smallMemCache = new TranscriptCache({
      maxEntries: 50,
      maxEstimatedBytes: 1024 * 1024, // 1 MB floor
    });
    for (let i = 0; i < 10; i++) {
      // Each entry ~400 KB estimated (20 msgs * 10k chars * 2 bytes)
      smallMemCache.set(`big-${i}`, 'fp', 20, makeTranscript(`big-${i}`, 20, { payloadSize: 10_000 }));
    }
    expect(smallMemCache.stats().entries).toBeLessThanOrEqual(3);
    expect(smallMemCache.stats().estimatedBytes).toBeLessThanOrEqual(1024 * 1024);
  });

  it('deduplicates concurrent in-flight loads for the same session/fingerprint/limit', async () => {
    const cache = new TranscriptCache();
    let resolveLoader!: (val: SessionTranscriptResult) => void;
    const loader = vi.fn(
      () =>
        new Promise<SessionTranscriptResult>((resolve) => {
          resolveLoader = resolve;
        })
    );

    const promises = Array.from({ length: 8 }, () =>
      cache.getOrLoad('s1', 'fp-1', 40, loader)
    );
    expect(loader).toHaveBeenCalledTimes(1);

    const payload = makeTranscript('s1', 10);
    resolveLoader(payload);
    const results = await Promise.all(promises);

    expect(results).toHaveLength(8);
    for (const r of results) expect(r).toBe(payload);
    expect(cache.stats().deduped).toBe(7);
    expect(cache.stats().misses).toBe(1);

    // Subsequent call hits cache directly
    const second = await cache.getOrLoad('s1', 'fp-1', 40, loader);
    expect(second).toBe(payload);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(cache.stats().hits).toBe(1);
  });

  it('supports invalidate and clear', () => {
    const cache = new TranscriptCache();
    cache.set('s1', 'fp', 10, makeTranscript('s1', 3));
    cache.set('s2', 'fp', 10, makeTranscript('s2', 3));

    cache.invalidate('s1');
    expect(cache.get('s1', 'fp', 10)).toBeNull();
    expect(cache.get('s2', 'fp', 10)).not.toBeNull();

    cache.clear();
    expect(cache.stats().entries).toBe(0);
    expect(cache.stats().estimatedBytes).toBe(0);
  });
});
