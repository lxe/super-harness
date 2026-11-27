import { spawn, type ChildProcess } from 'node:child_process';
import type {
  HarnessGroup,
  SessionConfigChange,
  SessionConfigFieldResult,
  SessionConfigResult,
  ImageAttachment,
  SendMessageResult,
  StartSessionRequest,
  StreamEvent,
} from '../../shared/types';
import type { HarnessRegistry } from '../adapters/registry';
import type { DaemonControlAction, DispatchContext } from '../adapters/types';
import { moveFileAttachmentsIntoPrompt } from '../adapters/types';
import type { ConfigStore } from '../store/configStore';

function harnessGroupForStartRequest(harness: StartSessionRequest['harness']): HarnessGroup {
  if (harness === 'codex') return 'codex';
  if (harness === 'antigravity') return 'antigravity';
  if (harness === 'muse') return 'muse';
  if (harness === 'pi') return 'pi';
  return 'claude';
}

/**
 * Harness-agnostic execution & process lifecycle coordinator.
 * Owns child-process streaming, abort/shutdown cleanup, and local archive
 * fallbacks while delegating all harness-specific protocols to HarnessDrivers.
 */
export class HarnessDispatcher {
  private activeRuns = new Map<string, ChildProcess>();
  /** Messages waiting for their session's running turn to end (a steer never stops a turn). */
  private held: Array<{
    sessionId: string;
    prompt: string;
    attachments?: ImageAttachment[];
    heldAt: number;
    idleChecks: number;
  }> = [];
  private holdTimer: ReturnType<typeof setInterval> | null = null;
  /** How often held messages are checked, and how long one may wait. */
  static holdPollMs = 2000;
  static holdMaxMs = 45 * 60_000;

  constructor(
    private readonly registry: HarnessRegistry,
    private readonly store: ConfigStore,
    private readonly emitStream: (ev: StreamEvent) => void,
    private readonly triggerRefresh: () => void
  ) {}

  private createContext(): DispatchContext {
    return {
      spawnStreaming: (opts) => this.spawnStreaming(opts),
      emitStream: this.emitStream,
      triggerRefresh: (delayMs) => {
        if (delayMs && delayMs > 0) {
          setTimeout(() => this.triggerRefresh(), delayMs);
        } else {
          this.triggerRefresh();
        }
      },
    };
  }

  shutdown(): void {
    for (const proc of this.activeRuns.values()) {
      try {
        proc.kill('SIGTERM');
      } catch {
        // ignore
      }
    }
    this.activeRuns.clear();
    for (const driver of this.registry.getDrivers()) {
      driver.shutdown?.();
    }
  }

  abort(sessionId: string): boolean {
    const session = this.registry.getSession(sessionId);
    for (const driver of this.registry.getDrivers()) {
      if (driver.abort?.(sessionId, this.emitStream, session)) {
        setTimeout(() => this.triggerRefresh(), 500);
        setTimeout(() => this.triggerRefresh(), 1500);
        return true;
      }
    }

    const proc = this.activeRuns.get(sessionId);
    if (!proc) return false;
    try {
      proc.kill('SIGTERM');
    } catch {
      // ignore
    }
    this.activeRuns.delete(sessionId);
    this.emitStream({
      sessionId,
      runId: 'abort',
      kind: 'done',
    });
    return true;
  }

  async sendToSession(
    sessionId: string,
    prompt: string,
    attachments?: ImageAttachment[],
    opts?: { force?: boolean }
  ): Promise<SendMessageResult> {
    let session = this.registry.getSession(sessionId);
    if (!session) {
      await this.registry.discover();
      session = this.registry.getSession(sessionId);
    }
    if (!session) {
      return { ok: false, error: `Session not found: ${sessionId}` };
    }
    if (session.harnessGroup === 'master') {
      return { ok: false, error: 'Master session is handled by MasterEngine' };
    }

    const driver = this.registry.getDriver(session.harnessGroup);
    if (!driver) {
      return { ok: false, error: `No driver registered for ${session.harnessGroup}` };
    }

    // Remote-host adapters copy every attachment to their host themselves; local ones get
    // non-image files as path references in the prompt.
    if (!session.tags?.includes('remote-host')) {
      ({ prompt, attachments } = moveFileAttachmentsIntoPrompt(prompt, attachments));
    }
    const res = await driver.sendMessage(session, prompt, attachments, this.createContext(), opts);
    if (!res.ok && res.holdUntilIdle) {
      this.hold(sessionId, prompt, attachments);
      console.log(`[dispatcher] held session=${sessionId} until its turn ends (${res.error || 'mid-turn'})`);
      return { ok: true, dispatchedVia: 'held until the current turn ends' };
    }
    if (!res.ok) {
      console.error(
        `[dispatcher] sendMessage failed session=${sessionId} harness=${session.harnessGroup} force=${Boolean(opts?.force)}: ${res.error || 'unknown error'}`
      );
    } else {
      console.log(
        `[dispatcher] sent session=${sessionId} via=${res.dispatchedVia || session.harnessGroup} force=${Boolean(opts?.force)}`
      );
    }
    return res;
  }

  /** Holds a message until its session is idle, then sends it as a normal message. */
  private hold(sessionId: string, prompt: string, attachments?: ImageAttachment[]): void {
    this.held.push({ sessionId, prompt, attachments, heldAt: Date.now(), idleChecks: 0 });
    if (!this.holdTimer) {
      this.holdTimer = setInterval(() => void this.flushHeld(), HarnessDispatcher.holdPollMs);
      this.holdTimer.unref?.();
    }
  }

  /** Sends held messages whose session has been idle for two checks in a row, oldest first. */
  async flushHeld(): Promise<void> {
    const pending = this.held;
    this.held = [];
    const sentThisRound = new Set<string>();
    for (const item of pending) {
      if (Date.now() - item.heldAt > HarnessDispatcher.holdMaxMs) {
        console.error(`[dispatcher] dropped a held message for ${item.sessionId}: its turn never ended`);
        continue;
      }
      const session = this.registry.getSession(item.sessionId);
      const busy = !session || session.status === 'running' || sentThisRound.has(item.sessionId);
      item.idleChecks = busy ? 0 : item.idleChecks + 1;
      if (item.idleChecks < 2) {
        this.held.push(item);
        continue;
      }
      const driver = this.registry.getDriver(session!.harnessGroup as HarnessGroup);
      if (!driver) continue;
      const res = await driver.sendMessage(session!, item.prompt, item.attachments, this.createContext(), {
        force: false,
      });
      if (!res.ok && res.holdUntilIdle) {
        item.idleChecks = 0;
        this.held.push(item);
        continue;
      }
      sentThisRound.add(item.sessionId);
      console.log(`[dispatcher] sent held message session=${item.sessionId} ok=${res.ok}${res.error ? ` error=${res.error}` : ''}`);
    }
    if (this.held.length === 0 && this.holdTimer) {
      clearInterval(this.holdTimer);
      this.holdTimer = null;
    }
  }

  async queueToSession(
    sessionId: string,
    prompt: string,
    attachments?: ImageAttachment[]
  ): Promise<SendMessageResult> {
    let session = this.registry.getSession(sessionId);
    if (!session) {
      await this.registry.discover();
      session = this.registry.getSession(sessionId);
    }
    if (!session) {
      return { ok: false, error: `Session not found: ${sessionId}` };
    }
    if (session.harnessGroup === 'master') {
      return { ok: false, error: 'Master session does not support native queueing' };
    }

    const driver = this.registry.getDriver(session.harnessGroup);
    if (!driver?.queueMessage) {
      // Harnesses without a separate native queue endpoint (e.g. Antigravity) handle
      // non-forced sends cleanly via their normal dispatch path.
      return this.sendToSession(sessionId, prompt, attachments, { force: false });
    }

    if (!session.tags?.includes('remote-host')) {
      ({ prompt, attachments } = moveFileAttachmentsIntoPrompt(prompt, attachments));
    }
    const res = await driver.queueMessage(session, prompt, attachments, this.createContext());
    if (!res) {
      return this.sendToSession(sessionId, prompt, attachments, { force: false });
    }
    return res;
  }

  async startNewSession(req: StartSessionRequest): Promise<{
    ok: boolean;
    sessionId?: string;
    error?: string;
  }> {
    const group = harnessGroupForStartRequest(req.harness);
    const driver = this.registry.getDriver(group);
    if (!driver) {
      return { ok: false, error: `Unknown harness: ${req.harness}` };
    }
    const moved = moveFileAttachmentsIntoPrompt(req.prompt ?? '', req.attachments);
    return driver.startSession(
      { ...req, prompt: moved.prompt, attachments: moved.attachments },
      this.createContext()
    );
  }

  /**
   * Change a session's model / reasoning effort / permission mode through its driver.
   * Fields the driver accepts (applied now or on the next message) are persisted as
   * Superharness overrides so every later dispatch, on any client, uses them.
   */
  async updateSessionConfig(sessionId: string, change: SessionConfigChange): Promise<SessionConfigResult> {
    const session = this.registry.getSession(sessionId);
    if (!session) return { ok: false, sessionId, results: [], error: `Unknown session: ${sessionId}` };
    const driver = this.registry.getDriver(session.harnessGroup as HarnessGroup);
    const requested = (['model', 'reasoningEffort', 'permissionMode'] as const).filter(
      (f) => change[f] !== undefined
    );
    if (requested.length === 0) {
      return { ok: false, sessionId, harness: session.harness, results: [], error: 'Nothing to change: pass model, reasoningEffort and/or permissionMode.' };
    }
    const results: SessionConfigFieldResult[] = driver?.applySessionConfig
      ? await driver.applySessionConfig(session, change, this.createContext())
      : requested.map((field) => ({
          field,
          requested: String(change[field]),
          status: 'unsupported' as const,
          detail: `${session.harness} sessions don't support changing this from Superharness.`,
        }));
    const keep = results.filter((r) => r.status === 'applied' || r.status === 'next_message');
    if (keep.length > 0) {
      const action: Record<string, unknown> = { type: 'set_model', sessionId };
      for (const r of keep) action[r.field] = r.value ?? '';
      this.store.applyOrganize([action as never]);
    }
    return { ok: results.every((r) => r.status === 'applied' || r.status === 'next_message'), sessionId, harness: session.harness, results };
  }

  async controlHarness(
    harness: HarnessGroup,
    action: DaemonControlAction
  ): Promise<{ ok: boolean; output?: string; error?: string }> {
    const driver = this.registry.getDriver(harness);
    if (!driver) {
      return { ok: false, error: `Unknown harness: ${harness}` };
    }
    try {
      return await driver.controlDaemon(action, this.createContext());
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Archives a session using the owning HarnessDriver's native archive method
   * when available, falling back to hiding it in Superharness state.
   */
  async archiveSession(
    sessionId: string,
    opts?: { killTmux?: boolean }
  ): Promise<{ ok: boolean; method?: string; error?: string }> {
    const trimmedId = sessionId.trim();
    if (!trimmedId) return { ok: false, error: 'sessionId required' };
    let session = this.registry.getSession(trimmedId);
    if (!session) {
      await this.registry.discover();
      session = this.registry.getSession(trimmedId);
    }
    if (!session) {
      // Even if discovery temporarily missed the session (e.g. remote host hiccup or
      // already filtered out), persist the local hide so it never reappears on later polls.
      this.store.applyOrganize([{ type: 'hide_session', sessionId: trimmedId }]);
      this.registry.invalidateTranscriptCache(trimmedId);
      this.triggerRefresh();
      return { ok: true, method: 'Superharness archive' };
    }

    try {
      const driver =
        session.harnessGroup !== 'master'
          ? this.registry.getDriver(session.harnessGroup)
          : undefined;
      const nativeRes = driver ? await driver.archiveSession(session, opts) : null;

      if (nativeRes && nativeRes.ok) {
        if (nativeRes.hideLocally) {
          this.store.applyOrganize([{ type: 'hide_session', sessionId: trimmedId }]);
        }
        this.registry.invalidateTranscriptCache(trimmedId);
        this.triggerRefresh();
        return { ok: true, method: nativeRes.method, error: nativeRes.error };
      }

      this.store.applyOrganize([{ type: 'hide_session', sessionId: trimmedId }]);
      this.registry.invalidateTranscriptCache(trimmedId);
      this.triggerRefresh();
      return { ok: true, method: 'Superharness archive' };
    } catch (err) {
      // Never leave an archive request half-applied when native archive throws: fall back to local hide.
      this.store.applyOrganize([{ type: 'hide_session', sessionId: trimmedId }]);
      this.registry.invalidateTranscriptCache(trimmedId);
      this.triggerRefresh();
      return {
        ok: true,
        method: 'Superharness archive',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async promoteToTmux(
    sessionId: string
  ): Promise<{ ok: boolean; tmuxSession?: string; error?: string }> {
    let session = this.registry.getSession(sessionId);
    if (!session) {
      await this.registry.discover();
      session = this.registry.getSession(sessionId);
    }
    if (!session) return { ok: false, error: 'Session not found' };
    if (session.harnessGroup === 'master') {
      return { ok: false, error: 'Master session cannot be moved to tmux' };
    }
    const driver = this.registry.getDriver(session.harnessGroup);
    if (!driver?.promoteToTmux) {
      return { ok: false, error: `tmux handoff not supported for ${session.harnessGroup}` };
    }
    return driver.promoteToTmux(session, this.createContext());
  }

  private spawnStreaming(opts: {
    sessionId: string;
    runId: string;
    bin: string;
    args: string[];
    cwd: string;
    parseLine: (line: string, gotAnyDelta: boolean) => boolean;
  }): void {
    const { sessionId, runId, bin, args, cwd, parseLine } = opts;
    this.abort(sessionId);

    const child = spawn(bin, args, {
      cwd,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.activeRuns.set(sessionId, child);
    this.emitStream({ sessionId, runId, kind: 'start' });

    let stdoutBuf = '';
    let stderrBuf = '';
    let gotAnyDelta = false;

    const handleLine = (line: string) => {
      if (parseLine(line, gotAnyDelta)) {
        gotAnyDelta = true;
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString('utf8');
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop() ?? '';
      for (const line of lines) handleLine(line);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      this.activeRuns.delete(sessionId);
      this.emitStream({
        sessionId,
        runId,
        kind: 'error',
        error: err.message,
      });
      this.emitStream({ sessionId, runId, kind: 'done' });
    });

    child.on('close', (code) => {
      if (stdoutBuf.trim()) handleLine(stdoutBuf);
      this.activeRuns.delete(sessionId);
      if (code && code !== 0) {
        const errText = stderrBuf.trim() || `Harness exited with code ${code}`;
        this.emitStream({
          sessionId,
          runId,
          kind: 'error',
          error: errText.slice(0, 1500),
        });
      }
      this.emitStream({ sessionId, runId, kind: 'done' });
      setTimeout(() => this.triggerRefresh(), 800);
      setTimeout(() => this.triggerRefresh(), 2500);
    });
  }
}
