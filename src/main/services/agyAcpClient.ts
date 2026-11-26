import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ImageAttachment, StreamEvent } from '../../shared/types';
import { whichBinary } from '../utils/system';

type AppDataDirName = 'antigravity' | 'antigravity-cli';

const EXTERNAL_TURN_FRESHNESS_MS = 35_000;

/**
 * Inspects the tail of an Antigravity `transcript.jsonl` file to determine whether
 * an external Antigravity Desktop/CLI process is actively executing a turn right now.
 * Prevents `agy acp` from starting an overlapping parallel turn that would fork
 * conversation state on disk.
 */
export function isExternalAntigravityTurnActive(
  transcriptPath: string,
  nowMs: number = Date.now()
): boolean {
  try {
    if (!fs.existsSync(transcriptPath)) return false;
    const st = fs.statSync(transcriptPath);
    if (nowMs - st.mtimeMs >= EXTERNAL_TURN_FRESHNESS_MS) return false;

    const readBytes = Math.min(st.size, 65_536);
    if (readBytes <= 0) return false;

    const fd = fs.openSync(transcriptPath, 'r');
    let tailText = '';
    try {
      const buf = Buffer.allocUnsafe(readBytes);
      const bytesRead = fs.readSync(fd, buf, 0, readBytes, Math.max(0, st.size - readBytes));
      tailText = buf.subarray(0, bytesRead).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }

    const lines = tailText.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const trimmed = lines[i].trim();
      if (!trimmed) continue;
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        continue;
      }
      const stepType = typeof obj.type === 'string' ? obj.type : '';
      const status = typeof obj.status === 'string' ? obj.status : '';
      if (!stepType && !status) continue;

      if (status === 'RUNNING') return true;
      if (stepType === 'GENERIC' || stepType === 'SYSTEM_MESSAGE' || stepType === 'USER_INPUT') {
        return true;
      }
      if (stepType === 'PLANNER_RESPONSE') {
        return Array.isArray(obj.tool_calls) && obj.tool_calls.length > 0;
      }
      // Any other completed terminal step (e.g. final text-only PLANNER_RESPONSE or DONE)
      return false;
    }
    return false;
  } catch {
    return false;
  }
}

interface PendingRpc {
  resolve: (result: Record<string, unknown>) => void;
  reject: (err: Error) => void;
}

interface ActivePromptRun {
  shSessionId: string;
  nativeSessionId: string;
  runId: string;
  onEvent: (ev: StreamEvent) => void;
}

/**
 * Persistent JSON-RPC 2.0 client for Antigravity's official Agent Client Protocol
 * (`agy acp --app-data-dir <antigravity | antigravity-cli>`).
 *
 * Gives Super Harness direct, native, bidirectional read+write control over BOTH
 * Antigravity Desktop conversations (`~/.gemini/antigravity`) and Antigravity CLI
 * conversations (`~/.gemini/antigravity-cli`), including native multimodal image blocks
 * and live `session/cancel`.
 */
class AcpConnection {
  private proc: ChildProcess | null = null;
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRpc>();
  private resumedSessions = new Set<string>();
  private lastAppliedModel = new Map<string, string>();
  private lastTranscriptMtime = new Map<string, number>();
  private activeRuns = new Map<string, ActivePromptRun>(); // nativeSessionId -> run
  private stdoutBuf = '';
  private stderrTail = '';

  constructor(private readonly appDataDir: AppDataDirName) {}

  private getTranscriptPath(nativeSessionId: string): string {
    return path.join(
      os.homedir(),
      '.gemini',
      this.appDataDir,
      'brain',
      nativeSessionId,
      '.system_generated',
      'logs',
      'transcript.jsonl'
    );
  }

  private getTranscriptMtime(nativeSessionId: string): number {
    try {
      const tr = this.getTranscriptPath(nativeSessionId);
      return fs.existsSync(tr) ? fs.statSync(tr).mtimeMs : 0;
    } catch {
      return 0;
    }
  }

  private async ensureConnected(): Promise<void> {
    if (this.proc && this.initialized && !this.proc.killed) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      const bin = await whichBinary('agy');
      if (!bin) throw new Error('agy binary not found in PATH');

      const child = spawn(
        bin,
        ['acp', '--app-data-dir', this.appDataDir],
        {
          env: { ...process.env },
          stdio: ['pipe', 'pipe', 'pipe'],
        }
      );
      this.proc = child;
      this.initialized = false;
      this.resumedSessions.clear();
      this.stdoutBuf = '';
      this.stderrTail = '';

      child.stdout?.on('data', (chunk: Buffer) => {
        this.stdoutBuf += chunk.toString('utf8');
        const lines = this.stdoutBuf.split('\n');
        this.stdoutBuf = lines.pop() ?? '';
        for (const line of lines) this.handleLine(line);
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-2000);
      });

      child.on('exit', (code) => {
        this.proc = null;
        this.initialized = false;
        this.initPromise = null;
        this.resumedSessions.clear();
        this.lastAppliedModel.clear();
        const err = new Error(
          `Antigravity ACP (${this.appDataDir}) exited (${code ?? 'signal'}): ${this.stderrTail.trim()}`
        );
        for (const p of this.pending.values()) p.reject(err);
        this.pending.clear();
        for (const run of this.activeRuns.values()) {
          run.onEvent({ sessionId: run.shSessionId, runId: run.runId, kind: 'error', error: err.message });
          run.onEvent({ sessionId: run.shSessionId, runId: run.runId, kind: 'done' });
        }
        this.activeRuns.clear();
      });

      await this.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: {},
      });
      this.initialized = true;
    })();

    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  private sendJson(obj: Record<string, unknown>): void {
    if (!this.proc?.stdin?.writable) {
      throw new Error('Antigravity ACP stdin not writable');
    }
    this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...obj })}\n`);
  }

  private request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      try {
        this.sendJson({ id, method, params });
      } catch (err) {
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return;
    }

    // 1. Response to one of our RPC requests
    if (typeof msg.id === 'number' && !msg.method) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        const e = msg.error as Record<string, unknown>;
        p.reject(new Error(String(e.message || JSON.stringify(e))));
      } else {
        p.resolve((msg.result ?? {}) as Record<string, unknown>);
      }
      return;
    }

    // 2. Server -> Client permission request (approve cleanly using allow_once / first allow option)
    if (msg.method === 'session/request_permission' && msg.id !== undefined) {
      const params = (msg.params ?? {}) as Record<string, unknown>;
      const options = Array.isArray(params.options)
        ? (params.options as Array<Record<string, unknown>>)
        : [];
      const preferred =
        options.find((o) => String(o.kind || '').includes('allow')) ?? options[0];
      const optionId = preferred?.optionId ?? preferred?.id ?? 'allow_once';
      try {
        this.sendJson({
          id: msg.id,
          result: { outcome: { outcome: 'selected', optionId } },
        });
      } catch {
        // ignore
      }
      return;
    }

    // 3. Server -> Client live streaming session updates
    if (msg.method === 'session/update') {
      const params = (msg.params ?? {}) as Record<string, unknown>;
      const nativeSid = String(params.sessionId || '');
      const run = this.activeRuns.get(nativeSid);
      if (!run) return;
      const update = (params.update ?? {}) as Record<string, unknown>;
      const kind = String(update.sessionUpdate || '');

      if (kind === 'agent_message_chunk') {
        const content = (update.content ?? {}) as Record<string, unknown>;
        if (content.type === 'text' && typeof content.text === 'string' && content.text) {
          run.onEvent({
            sessionId: run.shSessionId,
            runId: run.runId,
            kind: 'delta',
            text: content.text,
          });
        }
      } else if (kind === 'agent_thought_chunk') {
        const content = (update.content ?? {}) as Record<string, unknown>;
        if (content.type === 'text' && typeof content.text === 'string' && content.text) {
          run.onEvent({
            sessionId: run.shSessionId,
            runId: run.runId,
            kind: 'block',
            block: { type: 'thinking', text: content.text },
          });
        }
      } else if (kind === 'tool_call') {
        const title = String(update.title || update.name || 'tool');
        run.onEvent({
          sessionId: run.shSessionId,
          runId: run.runId,
          kind: 'block',
          block: {
            type: 'tool_call',
            name: title,
            status: String(update.status || 'running'),
          },
        });
      }
    }
  }

  async createSession(cwd: string, model?: string): Promise<string> {
    await this.ensureConnected();
    const safeCwd = fs.existsSync(cwd) ? cwd : os.homedir();
    const res = await this.request('session/new', { cwd: safeCwd, mcpServers: [] });
    const sid = String(res.sessionId || '');
    if (!sid) throw new Error('ACP session/new did not return a sessionId');
    if (model) {
      try {
        await this.request('session/set_model', { sessionId: sid, modelId: model });
        this.lastAppliedModel.set(sid, model);
      } catch {
        // Ignore if the ACP server doesn't expose session/set_model for this model
      }
    }
    this.resumedSessions.add(sid);
    return sid;
  }

  async sendPrompt(
    shSessionId: string,
    nativeSessionId: string,
    cwd: string,
    promptText: string,
    attachments: ImageAttachment[] | undefined,
    runId: string,
    onEvent: (ev: StreamEvent) => void,
    onComplete: () => void,
    model?: string
  ): Promise<void> {
    if (this.activeRuns.has(nativeSessionId)) {
      throw new Error(
        'This Antigravity conversation is already running a turn in Super Harness. Wait for it to finish or queue your message.'
      );
    }

    const transcriptPath = this.getTranscriptPath(nativeSessionId);
    if (isExternalAntigravityTurnActive(transcriptPath)) {
      throw new Error(
        'Antigravity Desktop is currently running a turn on this conversation. Wait for it to finish before sending from Super Harness so the conversation does not fork.'
      );
    }

    const currentMtime = this.getTranscriptMtime(nativeSessionId);
    const prevMtime = this.lastTranscriptMtime.get(nativeSessionId) ?? 0;
    const externallyUpdated =
      this.resumedSessions.has(nativeSessionId) && prevMtime > 0 && currentMtime > prevMtime + 500;

    // If Antigravity Desktop or CLI updated this conversation externally since our last ACP turn,
    // drop cached session state (and recycle the ACP worker when idle) so we re-load fresh disk state.
    if (externallyUpdated) {
      if (this.activeRuns.size === 0) {
        this.close();
      } else {
        this.resumedSessions.delete(nativeSessionId);
      }
    }

    await this.ensureConnected();
    const safeCwd = fs.existsSync(cwd) ? cwd : os.homedir();

    if (!this.resumedSessions.has(nativeSessionId)) {
      await this.request('session/resume', {
        sessionId: nativeSessionId,
        cwd: safeCwd,
        mcpServers: [],
      });
      this.resumedSessions.add(nativeSessionId);
    }

    if (model && this.lastAppliedModel.get(nativeSessionId) !== model) {
      try {
        await this.request('session/set_model', { sessionId: nativeSessionId, modelId: model });
        this.lastAppliedModel.set(nativeSessionId, model);
      } catch {
        // Ignore if the ACP server rejects session/set_model for this slug
      }
    }

    const promptBlocks: Array<Record<string, unknown>> = [];
    if (attachments && attachments.length > 0) {
      for (const att of attachments) {
        try {
          const data = fs.readFileSync(att.path).toString('base64');
          promptBlocks.push({
            type: 'image',
            mimeType: att.mimeType || 'image/png',
            data,
          });
        } catch {
          // fallback reference if file unreadable
          promptBlocks.push({ type: 'text', text: `[Attached image: ${att.path}]` });
        }
      }
    }
    if (promptText.trim()) {
      promptBlocks.push({ type: 'text', text: promptText.trim() });
    } else if (promptBlocks.length > 0) {
      promptBlocks.push({ type: 'text', text: 'Inspect the attached image(s).' });
    }

    this.activeRuns.set(nativeSessionId, {
      shSessionId,
      nativeSessionId,
      runId,
      onEvent,
    });
    onEvent({ sessionId: shSessionId, runId, kind: 'start' });

    // Run turn asynchronously so IPC `sendMessage` returns immediately while updates stream live
    void this.request('session/prompt', {
      sessionId: nativeSessionId,
      prompt: promptBlocks,
    })
      .catch((err) => {
        if (this.activeRuns.get(nativeSessionId)?.runId !== runId) return;
        // Drop cached resume flag in case session needs fresh resume next time
        this.resumedSessions.delete(nativeSessionId);
        onEvent({
          sessionId: shSessionId,
          runId,
          kind: 'error',
          error: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        this.lastTranscriptMtime.set(nativeSessionId, this.getTranscriptMtime(nativeSessionId));
        if (this.activeRuns.get(nativeSessionId)?.runId === runId) {
          this.activeRuns.delete(nativeSessionId);
          onEvent({ sessionId: shSessionId, runId, kind: 'done' });
          onComplete();
        }
      });
  }

  async cancel(nativeSessionId: string): Promise<boolean> {
    if (!this.activeRuns.has(nativeSessionId)) return false;
    this.activeRuns.delete(nativeSessionId);
    try {
      this.sendJson({
        method: 'session/cancel',
        params: { sessionId: nativeSessionId },
      });
      return true;
    } catch {
      return false;
    }
  }

  close(): void {
    try {
      this.proc?.kill('SIGTERM');
    } catch {
      // ignore
    }
    this.proc = null;
    this.initialized = false;
    this.resumedSessions.clear();
    this.lastAppliedModel.clear();
    this.activeRuns.clear();
  }
}

export class AgyAcpPool {
  private connections = new Map<AppDataDirName, AcpConnection>();

  private getConn(dir: AppDataDirName): AcpConnection {
    let conn = this.connections.get(dir);
    if (!conn) {
      conn = new AcpConnection(dir);
      this.connections.set(dir, conn);
    }
    return conn;
  }

  async sendPrompt(
    originApp: 'antigravity-app' | 'antigravity-cli',
    shSessionId: string,
    nativeSessionId: string,
    cwd: string,
    promptText: string,
    attachments: ImageAttachment[] | undefined,
    runId: string,
    onEvent: (ev: StreamEvent) => void,
    onComplete: () => void,
    model?: string
  ): Promise<void> {
    const dir: AppDataDirName = originApp === 'antigravity-cli' ? 'antigravity-cli' : 'antigravity';
    await this.getConn(dir).sendPrompt(
      shSessionId,
      nativeSessionId,
      cwd,
      promptText,
      attachments,
      runId,
      onEvent,
      onComplete,
      model
    );
  }

  async createSession(
    originApp: 'antigravity-app' | 'antigravity-cli',
    cwd: string,
    model?: string
  ): Promise<string> {
    const dir: AppDataDirName = originApp === 'antigravity-cli' ? 'antigravity-cli' : 'antigravity';
    return this.getConn(dir).createSession(cwd, model);
  }

  async cancel(nativeSessionId: string): Promise<boolean> {
    let cancelled = false;
    for (const conn of this.connections.values()) {
      if (await conn.cancel(nativeSessionId)) cancelled = true;
    }
    return cancelled;
  }

  closeAll(): void {
    for (const conn of this.connections.values()) {
      conn.close();
    }
    this.connections.clear();
  }
}
