import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ImageAttachment, StreamEvent, UnifiedBlock } from '../../shared/types';

/**
 * Pool of long-lived `pi --mode rpc` workers, one per Pi session Super Harness drives.
 *
 * Protocol (Pi 1.4 `docs/rpc.md`): one JSON command per line on stdin, `response` records
 * (correlated by `id`) and session events on stdout. Super Harness uses:
 *  - `prompt` to start a run, or `prompt` with `streamingBehavior: "steer"` while a run is
 *    active (Pi delivers it after the current tool calls, before the next model call);
 *  - `follow_up` only for an explicit queue request (delivered when the run finishes);
 *  - `set_model` / `set_thinking_level` for config changes, `abort` to stop.
 *
 * A worker appends to the same session JSONL file the Pi TUI uses, so the transcript the
 * adapter reads from disk is the source of truth; stream events only drive the live
 * overlay. Workers close after five idle minutes, and a worker whose session file was
 * changed by another process while it sat idle is recycled before the next prompt so it
 * never appends to a stale tree.
 */

const WORKER_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const RESPONSE_TIMEOUT_MS = 20_000;

export interface PiRpcTurnHooks {
  shSessionId: string;
  runId: string;
  onEvent: (ev: StreamEvent) => void;
  /** Called after each persisted message (Pi writes the session file at message_end). */
  onPersisted: () => void;
  onSettled: () => void;
}

interface PendingResponse {
  resolve: (data: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface PiWorker {
  key: string;
  proc: ChildProcess;
  stdoutBuf: string;
  stderrTail: string;
  pending: Map<string, PendingResponse>;
  seq: number;
  streaming: boolean;
  sessionFile?: string;
  /** Session file size/mtime after our own last write, to spot outside edits. */
  fileStamp?: string;
  hooks: PiRpcTurnHooks | null;
  idleTimer: NodeJS.Timeout | null;
  closed: boolean;
}

/** `provider/modelId` split at the first slash (model ids may contain more slashes). */
export function splitPiModelRef(ref: string): { provider: string; modelId: string } | null {
  const trimmed = ref.trim();
  const idx = trimmed.indexOf('/');
  if (idx <= 0 || idx === trimmed.length - 1) return null;
  return { provider: trimmed.slice(0, idx), modelId: trimmed.slice(idx + 1) };
}

/** Pi RPC `ImageContent` blocks for attachments (base64 from disk; unreadable files skipped). */
export function buildPiImages(
  attachments?: ImageAttachment[]
): Array<{ type: 'image'; data: string; mimeType: string }> {
  const out: Array<{ type: 'image'; data: string; mimeType: string }> = [];
  for (const att of attachments ?? []) {
    try {
      out.push({
        type: 'image',
        data: fs.readFileSync(att.path).toString('base64'),
        mimeType: att.mimeType?.startsWith('image/') ? att.mimeType : 'image/png',
      });
    } catch {
      // Attachment vanished; the text still goes through.
    }
  }
  return out;
}

function fileStamp(filePath?: string): string | undefined {
  if (!filePath) return undefined;
  try {
    const st = fs.statSync(filePath);
    return `${st.size}:${Math.floor(st.mtimeMs)}`;
  } catch {
    return undefined;
  }
}

/** Maps a finished Pi tool call to the live overlay block. */
function toolBlockFromCall(name: string, args: Record<string, unknown>): UnifiedBlock {
  if (name === 'bash' && typeof args.command === 'string') {
    return { type: 'command', command: args.command, status: 'running' };
  }
  return {
    type: 'tool_call',
    name,
    args: JSON.stringify(args, null, 2).slice(0, 4000),
    status: 'running',
  };
}

export interface PiSpawnOptions {
  bin: string;
  cwd: string;
  /** Existing session file, or omitted with `sessionId` to create a session. */
  sessionFile?: string;
  sessionId?: string;
  name?: string;
  model?: string;
  thinking?: string;
}

export function buildPiRpcArgs(opts: Omit<PiSpawnOptions, 'bin' | 'cwd'>): string[] {
  const args = ['--mode', 'rpc'];
  if (opts.sessionFile) args.push('--session', opts.sessionFile);
  else if (opts.sessionId) args.push('--session-id', opts.sessionId);
  if (opts.name?.trim()) args.push('--name', opts.name.trim());
  if (opts.model?.trim()) args.push('--model', opts.model.trim());
  if (opts.thinking?.trim()) args.push('--thinking', opts.thinking.trim());
  return args;
}

/**
 * Where the pool remembers the session-file stamp each worker left behind, so a restart of
 * Super Harness still knows which Pi sessions it wrote last (see `wroteLast`).
 */
export const PI_WRITTEN_STAMPS_PATH = path.join(os.homedir(), '.config', 'super-harness', 'pi-written.json');

export class PiRpcPool {
  private workers = new Map<string, PiWorker>();
  /** Session file stamp after each worker's last write, kept after the worker closes. */
  private lastWritten: Map<string, string>;

  constructor(private readonly stampsPath: string | null = PI_WRITTEN_STAMPS_PATH) {
    this.lastWritten = new Map();
    if (!stampsPath) return;
    try {
      const raw = JSON.parse(fs.readFileSync(stampsPath, 'utf8')) as Record<string, unknown>;
      for (const [k, v] of Object.entries(raw)) if (typeof v === 'string') this.lastWritten.set(k, v);
    } catch {
      // first run
    }
  }

  private rememberWrite(key: string, stamp: string): void {
    this.lastWritten.delete(key);
    this.lastWritten.set(key, stamp);
    if (!this.stampsPath) return;
    // Keep the newest 200 so the file stays small.
    const entries = Array.from(this.lastWritten.entries()).slice(-200);
    this.lastWritten = new Map(entries);
    try {
      fs.mkdirSync(path.dirname(this.stampsPath), { recursive: true });
      fs.writeFileSync(this.stampsPath, JSON.stringify(Object.fromEntries(entries)));
    } catch {
      // best effort
    }
  }

  /** True when the session file is exactly as a Super Harness worker last left it. */
  wroteLast(key: string, filePath: string): boolean {
    const stamp = this.lastWritten.get(key);
    return Boolean(stamp) && stamp === fileStamp(filePath);
  }

  /** Pids of our own workers, so discovery never mistakes them for a terminal. */
  ownPids(): Set<number> {
    const out = new Set<number>();
    for (const w of this.workers.values()) if (w.proc.pid) out.add(w.proc.pid);
    return out;
  }

  has(key: string): boolean {
    const w = this.workers.get(key);
    return Boolean(w && !w.closed);
  }

  isStreaming(key: string): boolean {
    return Boolean(this.workers.get(key)?.streaming);
  }

  sessionFileFor(key: string): string | undefined {
    return this.workers.get(key)?.sessionFile;
  }

  /**
   * Returns a live worker for `key`, spawning one if needed. An idle worker whose session
   * file changed since our last write is recycled first.
   */
  async ensure(key: string, opts: PiSpawnOptions): Promise<PiWorker> {
    let w = this.workers.get(key);
    if (w && (w.closed || !w.proc.stdin?.writable)) {
      this.close(key);
      w = undefined;
    }
    if (w && !w.streaming && w.fileStamp && w.sessionFile && fileStamp(w.sessionFile) !== w.fileStamp) {
      this.close(key);
      w = undefined;
    }
    if (!w) {
      w = this.spawnWorker(key, opts);
      const state = await this.request(w, { type: 'get_state' });
      if (typeof state.sessionFile === 'string') w.sessionFile = state.sessionFile;
      w.fileStamp = fileStamp(w.sessionFile);
    }
    if (w.idleTimer) {
      clearTimeout(w.idleTimer);
      w.idleTimer = null;
    }
    return w;
  }

  private spawnWorker(key: string, opts: PiSpawnOptions): PiWorker {
    const cwd = fs.existsSync(opts.cwd) ? opts.cwd : os.homedir();
    const proc = spawn(opts.bin, buildPiRpcArgs(opts), {
      cwd,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const w: PiWorker = {
      key,
      proc,
      stdoutBuf: '',
      stderrTail: '',
      pending: new Map(),
      seq: 0,
      streaming: false,
      sessionFile: opts.sessionFile,
      hooks: null,
      idleTimer: null,
      closed: false,
    };
    proc.stdout?.on('data', (chunk: Buffer) => {
      w.stdoutBuf += chunk.toString('utf8');
      // Split on LF only: U+2028/2029 are valid inside JSON strings (docs/rpc.md "Framing").
      let nl: number;
      while ((nl = w.stdoutBuf.indexOf('\n')) >= 0) {
        const line = w.stdoutBuf.slice(0, nl).replace(/\r$/, '');
        w.stdoutBuf = w.stdoutBuf.slice(nl + 1);
        if (line.trim()) this.handleLine(w, line);
      }
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      w.stderrTail = (w.stderrTail + chunk.toString('utf8')).slice(-2000);
    });
    const onExit = (err?: Error) => {
      if (w.closed) return;
      w.closed = true;
      if (this.workers.get(key) === w) this.workers.delete(key);
      if (w.idleTimer) clearTimeout(w.idleTimer);
      const reason = err?.message || w.stderrTail.trim().split('\n').pop() || 'pi exited';
      for (const p of w.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error(reason));
      }
      w.pending.clear();
      const hooks = w.hooks;
      w.hooks = null;
      if (hooks && w.streaming) {
        hooks.onEvent({ sessionId: hooks.shSessionId, runId: hooks.runId, kind: 'error', error: `Pi stopped: ${reason}` });
        hooks.onEvent({ sessionId: hooks.shSessionId, runId: hooks.runId, kind: 'done' });
        hooks.onSettled();
      }
      w.streaming = false;
    };
    proc.on('error', (err) => onExit(err));
    proc.on('close', () => onExit());
    this.workers.set(key, w);
    return w;
  }

  private handleLine(w: PiWorker, line: string): void {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = String(obj.type ?? '');
    if (type === 'response') {
      const id = typeof obj.id === 'string' ? obj.id : '';
      const p = id ? w.pending.get(id) : undefined;
      if (!p) return;
      w.pending.delete(id);
      clearTimeout(p.timer);
      if (obj.success === false) p.reject(new Error(String(obj.error ?? 'Pi rejected the command')));
      else p.resolve((obj.data ?? {}) as Record<string, unknown>);
      return;
    }
    if (type === 'extension_ui_request') {
      // Super Harness has no UI for extension dialogs; cancel so the run never stalls.
      const id = typeof obj.id === 'string' ? obj.id : undefined;
      const method = String(obj.method ?? '');
      if (id && ['select', 'confirm', 'input', 'editor'].includes(method)) {
        this.write(w, { type: 'extension_ui_response', id, cancelled: true });
      }
      return;
    }
    const hooks = w.hooks;
    const emit = (ev: Omit<StreamEvent, 'sessionId' | 'runId'>) => {
      if (hooks) hooks.onEvent({ sessionId: hooks.shSessionId, runId: hooks.runId, ...ev });
    };
    switch (type) {
      case 'agent_start':
        w.streaming = true;
        break;
      case 'message_start': {
        const msg = (obj.message ?? {}) as Record<string, unknown>;
        // Each assistant message gets a fresh overlay; the previous one is on disk by now.
        if (msg.role === 'assistant') emit({ kind: 'start' });
        break;
      }
      case 'message_update': {
        const ev = (obj.assistantMessageEvent ?? {}) as Record<string, unknown>;
        if (ev.type === 'text_delta' && typeof ev.delta === 'string' && ev.delta) {
          emit({ kind: 'delta', text: ev.delta });
        }
        break;
      }
      case 'tool_execution_start': {
        const args = (obj.args ?? {}) as Record<string, unknown>;
        emit({ kind: 'block', block: toolBlockFromCall(String(obj.toolName ?? 'tool'), args) });
        break;
      }
      case 'message_end': {
        const msg = (obj.message ?? {}) as Record<string, unknown>;
        if (msg.role === 'assistant' && msg.stopReason === 'error' && typeof msg.errorMessage === 'string') {
          emit({ kind: 'error', error: msg.errorMessage.slice(0, 1500) });
        }
        hooks?.onPersisted();
        break;
      }
      case 'agent_settled': {
        w.streaming = false;
        w.fileStamp = fileStamp(w.sessionFile);
        if (w.fileStamp) this.rememberWrite(w.key, w.fileStamp);
        w.hooks = null;
        if (hooks) {
          hooks.onEvent({ sessionId: hooks.shSessionId, runId: hooks.runId, kind: 'done' });
          hooks.onSettled();
        }
        this.scheduleIdleClose(w);
        break;
      }
      default:
        break;
    }
  }

  private write(w: PiWorker, obj: Record<string, unknown>): void {
    try {
      w.proc.stdin?.write(`${JSON.stringify(obj)}\n`);
    } catch {
      // Worker is closing; the exit handler settles everything.
    }
  }

  request(w: PiWorker, cmd: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = `sh-${++w.seq}`;
    return new Promise((resolve, reject) => {
      if (w.closed) {
        reject(new Error('Pi worker is not running'));
        return;
      }
      const timer = setTimeout(() => {
        w.pending.delete(id);
        reject(new Error(`Pi did not answer ${String(cmd.type)} within ${RESPONSE_TIMEOUT_MS / 1000}s`));
      }, RESPONSE_TIMEOUT_MS);
      w.pending.set(id, { resolve, reject, timer });
      this.write(w, { ...cmd, id });
    });
  }

  private scheduleIdleClose(w: PiWorker): void {
    if (w.idleTimer) clearTimeout(w.idleTimer);
    w.idleTimer = setTimeout(() => {
      if (!w.streaming) this.close(w.key);
    }, WORKER_IDLE_TIMEOUT_MS);
  }

  /**
   * Sends a prompt. While a run is active it steers (or, with `queue`, adds a follow-up);
   * otherwise it starts a run. Returns Pi's disposition (`started`, `queued`, `handled`).
   */
  async prompt(
    w: PiWorker,
    message: string,
    attachments: ImageAttachment[] | undefined,
    hooks: PiRpcTurnHooks,
    opts?: { queue?: boolean }
  ): Promise<string> {
    const images = buildPiImages(attachments);
    const base: Record<string, unknown> = { message };
    if (images.length > 0) base.images = images;
    if (w.streaming) {
      // Keep the hooks of the run already streaming; the steer lands inside it.
      const data = await this.request(w, opts?.queue ? { type: 'follow_up', ...base } : { type: 'steer', ...base });
      return String(data.disposition ?? 'queued');
    }
    w.hooks = hooks;
    hooks.onEvent({ sessionId: hooks.shSessionId, runId: hooks.runId, kind: 'start' });
    try {
      const data = await this.request(w, { type: 'prompt', ...base });
      const disposition = String(data.disposition ?? 'started');
      if (disposition === 'started') w.streaming = true;
      if (disposition === 'handled') {
        w.hooks = null;
        hooks.onEvent({ sessionId: hooks.shSessionId, runId: hooks.runId, kind: 'done' });
        hooks.onSettled();
        this.scheduleIdleClose(w);
      }
      return disposition;
    } catch (err) {
      w.hooks = null;
      hooks.onEvent({ sessionId: hooks.shSessionId, runId: hooks.runId, kind: 'done' });
      this.scheduleIdleClose(w);
      throw err;
    }
  }

  async setModel(w: PiWorker, ref: string): Promise<void> {
    const parsed = splitPiModelRef(ref);
    if (!parsed) throw new Error(`Pi model must be provider/modelId (got "${ref}")`);
    await this.request(w, { type: 'set_model', provider: parsed.provider, modelId: parsed.modelId });
  }

  async setThinking(w: PiWorker, level: string): Promise<void> {
    await this.request(w, { type: 'set_thinking_level', level });
  }

  async getState(w: PiWorker): Promise<Record<string, unknown>> {
    return this.request(w, { type: 'get_state' });
  }

  /** Aborts the active run (queued steers return to nothing: Super Harness has no editor to restore). */
  abort(key: string): boolean {
    const w = this.workers.get(key);
    if (!w || w.closed) return false;
    if (!w.streaming) return false;
    void this.request(w, { type: 'clear_queue' })
      .catch(() => undefined)
      .then(() => this.request(w, { type: 'abort' }))
      .catch(() => this.close(key));
    return true;
  }

  close(key: string): void {
    const w = this.workers.get(key);
    if (!w) return;
    this.workers.delete(key);
    if (w.idleTimer) clearTimeout(w.idleTimer);
    try {
      w.proc.stdin?.end();
    } catch {
      // ignore
    }
    // Closing stdin asks Pi to shut down cleanly; make sure it goes.
    setTimeout(() => {
      try {
        if (!w.closed) w.proc.kill('SIGTERM');
      } catch {
        // ignore
      }
    }, 3000).unref?.();
  }

  closeAll(): void {
    for (const key of Array.from(this.workers.keys())) this.close(key);
  }
}

/** One-shot RPC query in a throwaway `--no-session` process (catalog lookups). */
export async function runPiRpcQuery(
  bin: string,
  commands: Array<Record<string, unknown>>,
  timeoutMs = 8000
): Promise<Array<Record<string, unknown> | null>> {
  return new Promise((resolve) => {
    const proc = spawn(bin, ['--mode', 'rpc', '--no-session', '--offline'], {
      cwd: os.homedir(),
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const results: Array<Record<string, unknown> | null> = commands.map(() => null);
    let remaining = commands.length;
    let buf = '';
    const finish = () => {
      clearTimeout(timer);
      try {
        proc.stdin?.end();
        proc.kill('SIGTERM');
      } catch {
        // ignore
      }
      resolve(results);
    };
    const timer = setTimeout(finish, timeoutMs);
    proc.on('error', finish);
    proc.on('close', finish);
    proc.stdout?.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        try {
          const obj = JSON.parse(line) as Record<string, unknown>;
          if (obj.type !== 'response' || typeof obj.id !== 'string') continue;
          const idx = Number(obj.id.replace('q', ''));
          if (Number.isInteger(idx) && idx >= 0 && idx < results.length && results[idx] === null) {
            results[idx] = obj.success === false ? null : ((obj.data ?? {}) as Record<string, unknown>);
            remaining--;
            if (remaining === 0) finish();
          }
        } catch {
          // ignore non-JSON
        }
      }
    });
    commands.forEach((cmd, i) => proc.stdin?.write(`${JSON.stringify({ ...cmd, id: `q${i}` })}\n`));
  });
}
