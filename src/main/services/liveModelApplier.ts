import type {
  OrganizeAction,
  SessionConfigChange,
  SessionConfigResult,
  UnifiedSession,
} from '../../shared/types';

/** A Claude TUI in tmux: it takes model and effort only at launch. */
export function isLiveClaudeTmux(session: UnifiedSession | undefined): boolean {
  return Boolean(
    session && session.harness === 'claude-tmux' && session.dispatchMode === 'tmux-send' && session.tmuxTarget
  );
}

interface Deps {
  getSession(id: string): UnifiedSession | undefined;
  /** Applies the change through the session's driver (dispatcher.updateSessionConfig). */
  apply(id: string, change: SessionConfigChange): Promise<SessionConfigResult>;
  /** How often a pick waiting for its session to go idle is retried. */
  retryMs?: number;
}

/**
 * Makes a model or effort picked in a picker (desktop or phone) take effect on a Claude
 * session that runs in a terminal. The picker only stores the choice; Claude reads model and
 * effort at launch. So after a pick this restarts that Claude in place (`--resume`, same pane)
 * once the session is idle. Only picks made while the app runs are applied: stored choices are
 * never replayed at startup, which would restart every terminal session at once.
 */
export class LiveModelApplier {
  private readonly pending = new Map<string, { model?: string; reasoningEffort?: string }>();
  private readonly applying = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: Deps) {}

  /** Call with every batch of organize actions that comes from a client. */
  note(actions: readonly OrganizeAction[]): void {
    for (const a of actions) {
      if (a.type !== 'set_model' || !a.sessionId) continue;
      if (a.model === undefined && a.reasoningEffort === undefined) continue;
      if (!isLiveClaudeTmux(this.deps.getSession(a.sessionId))) continue;
      const prev = this.pending.get(a.sessionId) ?? {};
      this.pending.set(a.sessionId, {
        ...prev,
        ...(a.model !== undefined ? { model: a.model ?? '' } : {}),
        ...(a.reasoningEffort !== undefined ? { reasoningEffort: a.reasoningEffort ?? '' } : {}),
      });
    }
    if (this.pending.size > 0) {
      void this.flush();
      this.ensureTimer();
    }
  }

  pendingSessionIds(): string[] {
    return [...this.pending.keys()];
  }

  /** Applies every waiting pick whose session is idle now. */
  async flush(): Promise<void> {
    for (const [id, want] of [...this.pending]) {
      if (this.applying.has(id)) continue;
      const session = this.deps.getSession(id);
      if (!isLiveClaudeTmux(session)) {
        // Gone, or no longer a terminal session: the stored choice applies on its next launch.
        this.pending.delete(id);
        continue;
      }
      if (session!.status === 'running') continue; // never restart Claude mid-turn
      this.applying.add(id);
      try {
        const result = await this.deps.apply(id, { ...want, restart: true });
        // Claude started a turn between the check and the restart: try again when it is idle.
        const wentBusy = !result.ok && this.deps.getSession(id)?.status === 'running';
        // A newer pick made during the restart stays queued.
        if (!wentBusy && this.pending.get(id) === want) this.pending.delete(id);
      } catch {
        this.pending.delete(id);
      } finally {
        this.applying.delete(id);
      }
    }
    if (this.pending.size === 0) this.stopTimer();
  }

  dispose(): void {
    this.stopTimer();
    this.pending.clear();
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), this.deps.retryMs ?? 3000);
    this.timer.unref?.();
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
