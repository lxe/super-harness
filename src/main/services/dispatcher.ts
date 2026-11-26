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

    const res = await driver.sendMessage(session, prompt, attachments, this.createContext(), opts);
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
      return { ok: false, error: `Native queueing not supported for ${session.harnessGroup}` };
    }

    const res = await driver.queueMessage(session, prompt, attachments, this.createContext());
    if (!res) {
      return { ok: false, error: `Native queueing not supported for ${session.harnessGroup}` };
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
    return driver.startSession(req, this.createContext());
  }

  /**
   * Change a session's model / reasoning effort / permission mode through its driver.
   * Fields the driver accepts (applied now or on the next message) are persisted as
   * Super Harness overrides so every later dispatch, on any client, uses them.
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
          detail: `${session.harness} sessions don't support changing this from Super Harness.`,
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
   * when available, falling back to hiding it in Super Harness state.
   */
  async archiveSession(
    sessionId: string,
    opts?: { killTmux?: boolean }
  ): Promise<{ ok: boolean; method?: string; error?: string }> {
    let session = this.registry.getSession(sessionId);
    if (!session) {
      await this.registry.discover();
      session = this.registry.getSession(sessionId);
    }
    if (!session) return { ok: false, error: 'Session not found' };

    try {
      const driver =
        session.harnessGroup !== 'master'
          ? this.registry.getDriver(session.harnessGroup)
          : undefined;
      const nativeRes = driver ? await driver.archiveSession(session, opts) : null;

      if (nativeRes) {
        if (nativeRes.hideLocally) {
          this.store.applyOrganize([{ type: 'hide_session', sessionId }]);
        }
        this.registry.invalidateTranscriptCache(sessionId);
        this.triggerRefresh();
        return { ok: nativeRes.ok, method: nativeRes.method, error: nativeRes.error };
      }

      this.store.applyOrganize([{ type: 'hide_session', sessionId }]);
      this.registry.invalidateTranscriptCache(sessionId);
      this.triggerRefresh();
      return { ok: true, method: 'Super Harness archive' };
    } catch (err) {
      return {
        ok: false,
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
