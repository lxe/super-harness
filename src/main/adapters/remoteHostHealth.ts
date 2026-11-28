/** After this many failed polls in a row, a host's sessions show as offline. */
const OFFLINE_AFTER_FAILURES = 2;
const MAX_BACKOFF_MS = 60_000;

interface HostState {
  failures: number;
  lastAttemptAt: number;
  lastSeenAt?: number;
}

/**
 * Reachability of the SSH hosts a remote mirror polls. A host that stops answering is
 * polled less and less often (doubling up to a minute) instead of every tick, and its
 * last-known sessions are reported as offline with the time it was last seen.
 */
export class RemoteHostHealth {
  private hosts = new Map<string, HostState>();

  constructor(private readonly pollMs: number) {}

  shouldPoll(host: string, now = Date.now()): boolean {
    const s = this.hosts.get(host);
    if (!s || s.failures === 0) return true;
    const backoff = Math.min(MAX_BACKOFF_MS, this.pollMs * 2 ** s.failures);
    return now - s.lastAttemptAt >= backoff;
  }

  recordSuccess(host: string, now = Date.now()): void {
    this.hosts.set(host, { failures: 0, lastAttemptAt: now, lastSeenAt: now });
  }

  recordFailure(host: string, now = Date.now()): void {
    const s = this.hosts.get(host);
    this.hosts.set(host, { failures: (s?.failures ?? 0) + 1, lastAttemptAt: now, lastSeenAt: s?.lastSeenAt });
  }

  status(host: string): { offline: boolean; lastSeenAt?: number } {
    const s = this.hosts.get(host);
    return { offline: (s?.failures ?? 0) >= OFFLINE_AFTER_FAILURES, lastSeenAt: s?.lastSeenAt };
  }
}
