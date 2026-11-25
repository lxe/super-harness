import type { SessionTranscriptResult } from '../../shared/types';

interface CacheEntry {
  sessionId: string;
  fingerprint: string;
  limit: number;
  result: SessionTranscriptResult;
  estimatedBytes: number;
}

export interface TranscriptCacheOptions {
  maxEntries?: number;
  maxEstimatedBytes?: number;
}

export interface TranscriptCacheStats {
  entries: number;
  estimatedBytes: number;
  hits: number;
  misses: number;
  deduped: number;
}

function estimateResultBytes(res: SessionTranscriptResult): number {
  // Fast heuristic avoids JSON.stringify overhead on cache insert
  let bytes = 256;
  for (const m of res.messages) {
    bytes += 96;
    for (const b of m.blocks) {
      bytes += 64;
      if (b.type === 'text') bytes += b.text.length * 2;
      else if (b.type === 'thinking') bytes += b.text.length * 2 + (b.summary?.length ?? 0) * 2;
      else if (b.type === 'command') bytes += b.command.length * 2 + (b.output?.length ?? 0) * 2;
      else if (b.type === 'tool_call') bytes += (b.args?.length ?? 0) * 2 + (b.output?.length ?? 0) * 2;
      else if (b.type === 'file_change') {
        for (const ch of b.changes) bytes += ch.path.length * 2 + (ch.diff?.length ?? 0) * 2;
      } else if (b.type === 'image') bytes += (b.dataUrl?.length ?? 0) + (b.path?.length ?? 0) * 2;
      else if (b.type === 'question') bytes += b.questions.length * 256;
    }
  }
  return bytes;
}

/**
 * In-memory LRU transcript cache with fingerprint validation and concurrent
 * in-flight request deduplication. Switching back to an unchanged chat returns
 * in <0.1ms instead of re-reading and re-parsing disk transcripts.
 */
export class TranscriptCache {
  private readonly maxEntries: number;
  private readonly maxEstimatedBytes: number;
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<SessionTranscriptResult>>();
  private totalEstimatedBytes = 0;
  private hits = 0;
  private misses = 0;
  private deduped = 0;

  constructor(opts?: TranscriptCacheOptions) {
    this.maxEntries = Math.max(4, opts?.maxEntries ?? 64);
    this.maxEstimatedBytes = Math.max(1024 * 1024, opts?.maxEstimatedBytes ?? 40 * 1024 * 1024);
  }

  get(
    sessionId: string,
    fingerprint: string,
    requestedLimit: number
  ): SessionTranscriptResult | null {
    const entry = this.entries.get(sessionId);
    if (!entry) return null;
    if (entry.fingerprint !== fingerprint) return null;
    if (entry.limit < requestedLimit && entry.result.hasMore) return null;

    // Promote to MRU
    this.entries.delete(sessionId);
    this.entries.set(sessionId, entry);
    this.hits++;

    const res = entry.result;
    if (res.messages.length > requestedLimit) {
      return {
        ...res,
        messages: res.messages.slice(res.messages.length - requestedLimit),
        hasMore: true,
      };
    }
    return res;
  }

  set(
    sessionId: string,
    fingerprint: string,
    limit: number,
    result: SessionTranscriptResult
  ): void {
    const existing = this.entries.get(sessionId);
    if (existing) {
      this.totalEstimatedBytes -= existing.estimatedBytes;
      this.entries.delete(sessionId);
    }

    const estimatedBytes = estimateResultBytes(result);
    const entry: CacheEntry = {
      sessionId,
      fingerprint,
      limit,
      result,
      estimatedBytes,
    };

    this.entries.set(sessionId, entry);
    this.totalEstimatedBytes += estimatedBytes;
    this.evictIfNeeded();
  }

  async getOrLoad(
    sessionId: string,
    fingerprint: string,
    requestedLimit: number,
    loader: () => Promise<SessionTranscriptResult>
  ): Promise<SessionTranscriptResult> {
    const cached = this.get(sessionId, fingerprint, requestedLimit);
    if (cached) return cached;

    const flightKey = `${sessionId}::${fingerprint}::${requestedLimit}`;
    const existingFlight = this.inFlight.get(flightKey);
    if (existingFlight) {
      this.deduped++;
      return existingFlight;
    }

    this.misses++;
    const promise = loader()
      .then((res) => {
        this.set(sessionId, fingerprint, requestedLimit, res);
        return res;
      })
      .finally(() => {
        if (this.inFlight.get(flightKey) === promise) {
          this.inFlight.delete(flightKey);
        }
      });

    this.inFlight.set(flightKey, promise);
    return promise;
  }

  invalidate(sessionId: string): void {
    const existing = this.entries.get(sessionId);
    if (existing) {
      this.totalEstimatedBytes -= existing.estimatedBytes;
      this.entries.delete(sessionId);
    }
  }

  clear(): void {
    this.entries.clear();
    this.inFlight.clear();
    this.totalEstimatedBytes = 0;
  }

  stats(): TranscriptCacheStats {
    return {
      entries: this.entries.size,
      estimatedBytes: this.totalEstimatedBytes,
      hits: this.hits,
      misses: this.misses,
      deduped: this.deduped,
    };
  }

  private evictIfNeeded(): void {
    while (
      this.entries.size > 1 &&
      (this.entries.size > this.maxEntries || this.totalEstimatedBytes > this.maxEstimatedBytes)
    ) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      const removed = this.entries.get(oldestKey);
      if (removed) {
        this.totalEstimatedBytes -= removed.estimatedBytes;
      }
      this.entries.delete(oldestKey);
    }
  }
}
