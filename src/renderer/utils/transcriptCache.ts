import type { SessionTranscriptResult } from '../../shared/types';

export const DEFAULT_TRANSCRIPT_LIMIT = 40;

interface RendererCacheEntry {
  result: SessionTranscriptResult;
  fetchedLimit: number;
  cachedAt: number;
}

/**
 * Renderer-side LRU transcript cache enabling instant stale-while-revalidate
 * chat switching (zero Loading flash on revisit) plus hover/idle prefetching.
 */
export class RendererTranscriptCache {
  private readonly maxEntries: number;
  private readonly map = new Map<string, RendererCacheEntry>();
  private readonly inFlight = new Map<string, Promise<SessionTranscriptResult | null>>();

  constructor(maxEntries = 32) {
    this.maxEntries = Math.max(4, maxEntries);
  }

  get(sessionId: string): RendererCacheEntry | null {
    const entry = this.map.get(sessionId);
    if (!entry) return null;
    // Promote to MRU
    this.map.delete(sessionId);
    this.map.set(sessionId, entry);
    return entry;
  }

  set(sessionId: string, result: SessionTranscriptResult, fetchedLimit: number): void {
    const existing = this.map.get(sessionId);
    const effectiveLimit = existing
      ? Math.max(fetchedLimit, result.messages.length)
      : Math.max(fetchedLimit, result.messages.length);
    this.map.delete(sessionId);
    this.map.set(sessionId, {
      result,
      fetchedLimit: effectiveLimit,
      cachedAt: Date.now(),
    });
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  has(sessionId: string): boolean {
    return this.map.has(sessionId);
  }

  delete(sessionId: string): void {
    this.map.delete(sessionId);
  }

  clear(): void {
    this.map.clear();
    this.inFlight.clear();
  }

  size(): number {
    return this.map.size;
  }

  /**
   * Deduplicated prefetch helper — warms both the main-process cache and
   * renderer cache without triggering duplicate IPC calls.
   */
  prefetch(
    sessionId: string,
    fetcher: (id: string, limit: number) => Promise<SessionTranscriptResult>,
    limit = DEFAULT_TRANSCRIPT_LIMIT
  ): Promise<SessionTranscriptResult | null> {
    if (!sessionId || sessionId === 'master:root' || sessionId.startsWith('draft:')) {
      return Promise.resolve(null);
    }
    const existing = this.map.get(sessionId);
    if (existing && existing.fetchedLimit >= limit && Date.now() - existing.cachedAt < 15_000) {
      return Promise.resolve(existing.result);
    }
    const inflight = this.inFlight.get(sessionId);
    if (inflight) return inflight;

    const p = fetcher(sessionId, limit)
      .then((res) => {
        this.set(sessionId, res, limit);
        return res;
      })
      .catch(() => null)
      .finally(() => {
        if (this.inFlight.get(sessionId) === p) {
          this.inFlight.delete(sessionId);
        }
      });
    this.inFlight.set(sessionId, p);
    return p;
  }
}

/**
 * Checks whether a freshly fetched transcript result actually differs from
 * the one currently rendered, avoiding redundant React state updates and
 * scroll jumps during silent stale-while-revalidate refreshes.
 */
export function isTranscriptEquivalent(
  a: SessionTranscriptResult | null | undefined,
  b: SessionTranscriptResult
): boolean {
  if (!a) return false;
  if (a.sessionId !== b.sessionId) return false;
  if (a.sourceMtimeMs !== b.sourceMtimeMs) return false;
  if (a.totalCount !== b.totalCount) return false;
  if (a.hasMore !== b.hasMore) return false;
  if (a.messages.length !== b.messages.length) return false;
  if (Boolean(a.liveActivity?.isWorking) !== Boolean(b.liveActivity?.isWorking)) return false;
  if (a.liveActivity?.focus !== b.liveActivity?.focus) return false;
  const aQueue = a.liveActivity?.queuedMessages?.length ?? 0;
  const bQueue = b.liveActivity?.queuedMessages?.length ?? 0;
  if (aQueue !== bQueue) return false;
  if (a.messages.length > 0) {
    const aLast = a.messages[a.messages.length - 1];
    const bLast = b.messages[b.messages.length - 1];
    if (aLast.id !== bLast.id || aLast.blocks.length !== bLast.blocks.length) return false;
  }
  return true;
}

export const rendererTranscriptCache = new RendererTranscriptCache(32);

export function prefetchSessionTranscript(
  sessionId: string,
  limit = DEFAULT_TRANSCRIPT_LIMIT
): void {
  if (typeof window === 'undefined' || !window.superHarness?.getTranscript) return;
  void rendererTranscriptCache.prefetch(
    sessionId,
    (id, lim) => window.superHarness.getTranscript(id, lim),
    limit
  );
}
