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
