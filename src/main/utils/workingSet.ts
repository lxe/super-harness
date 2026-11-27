/**
 * Sessions the host marked as working outside discovery (a message just sent, or a watched
 * transcript that reported work) leave that set only when a watched transcript reports idle.
 * If nothing watches the session when the agent finishes (the phone left the chat or slept),
 * that never happens and the session shows as working forever. This returns the ids to drop:
 * not watched, older than the grace period, and idle by discovery's own detection.
 */
export function staleWorkingIds(opts: {
  working: Iterable<string>;
  addedAt: Map<string, number>;
  watched: Set<string>;
  discoveredRunning: (id: string) => boolean | undefined;
  now: number;
  graceMs?: number;
}): string[] {
  const grace = opts.graceMs ?? 15_000;
  const out: string[] = [];
  for (const id of opts.working) {
    if (opts.watched.has(id)) continue;
    if (opts.now - (opts.addedAt.get(id) ?? 0) < grace) continue;
    if (opts.discoveredRunning(id) === false) out.push(id);
  }
  return out;
}

/**
 * Tracks when sessions entered a working state across all signals (outbound message sent,
 * watched transcript activity, active stream, and background discovery) so task-completion
 * notifications fire reliably even when a session is not currently open in a watched pane
 * or when a message was dispatched from mobile before transcript polling began.
 */
export class WorkingCompletionTracker {
  private readonly workingSinceMs = new Map<string, number>();

  markWorking(sessionId: string, now = Date.now()): void {
    if (!sessionId || sessionId.startsWith('master:')) return;
    if (!this.workingSinceMs.has(sessionId)) {
      this.workingSinceMs.set(sessionId, now);
    }
  }

  markIdleAndCheckCompleted(
    sessionId: string,
    now = Date.now(),
    minDurationMs = 2000
  ): boolean {
    const startedAt = this.workingSinceMs.get(sessionId);
    this.workingSinceMs.delete(sessionId);
    if (!sessionId || sessionId.startsWith('master:')) return false;
    return startedAt !== undefined && now - startedAt >= minDurationMs;
  }

  /**
   * Reconciles the tracker with the full set of currently running sessions from discovery.
   * Returns session IDs that transitioned from running -> idle after at least `minDurationMs`.
   * Sessions that disappeared from `knownIds` are dropped without notifying.
   */
  reconcileDiscovery(opts: {
    runningIds: Iterable<string>;
    knownIds: Set<string>;
    now?: number;
    minDurationMs?: number;
  }): string[] {
    const now = opts.now ?? Date.now();
    const minDurationMs = opts.minDurationMs ?? 2000;
    const runningSet = new Set<string>();
    for (const id of opts.runningIds) {
      if (!id || id.startsWith('master:')) continue;
      runningSet.add(id);
      this.markWorking(id, now);
    }

    const completed: string[] = [];
    for (const id of Array.from(this.workingSinceMs.keys())) {
      if (runningSet.has(id)) continue;
      if (!opts.knownIds.has(id)) {
        this.workingSinceMs.delete(id);
        continue;
      }
      if (this.markIdleAndCheckCompleted(id, now, minDurationMs)) {
        completed.push(id);
      }
    }
    return completed;
  }

  has(sessionId: string): boolean {
    return this.workingSinceMs.has(sessionId);
  }
}
