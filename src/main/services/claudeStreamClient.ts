import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import type { ImageAttachment, StreamEvent } from '../../shared/types';
import { whichBinary } from '../utils/system';

const VALID_CLAUDE_PERM_MODES = new Set([
  'acceptEdits',
  'auto',
  'bypassPermissions',
  'manual',
  'dontAsk',
  'plan',
]);

const VALID_CLAUDE_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const WORKER_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

export interface ClaudeStreamLineHandler {
  (
    sessionId: string,
    runId: string,
    line: string,
    gotAnyDelta: boolean,
    emit: (ev: StreamEvent) => void
  ): boolean;
}

/**
 * Builds an official Claude `--input-format stream-json` NDJSON user message
 * with native multimodal base64 image blocks + text.
 */
export function buildClaudeStreamUserMessage(
  prompt: string,
  attachments?: ImageAttachment[]
): Record<string, unknown> {
  const content: Array<Record<string, unknown>> = [];

  if (attachments && attachments.length > 0) {
    for (const att of attachments) {
      try {
        const data = fs.readFileSync(att.path).toString('base64');
        const mediaType =
          att.mimeType && att.mimeType.startsWith('image/') ? att.mimeType : 'image/png';
        content.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: mediaType,
            data,
          },
        });
      } catch {
        content.push({ type: 'text', text: `[Attached image: ${att.path}]` });
      }
    }
  }

  const trimmed = prompt.trim();
  if (trimmed) {
    content.push({ type: 'text', text: trimmed });
  } else if (content.length > 0) {
    content.push({ type: 'text', text: 'Inspect the attached image(s).' });
  }

  return {
    type: 'user',
    message: {
      role: 'user',
      content,
    },
  };
}

export function buildClaudeStreamWorkerArgs(opts: {
  nativeSessionId: string;
  model?: string;
  reasoningEffort?: string;
  permissionMode?: string;
}): string[] {
  const args = [
    '--resume',
    opts.nativeSessionId,
    '--print',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
  ];
  if (opts.model?.trim()) {
    args.push('--model', opts.model.trim());
  }
  const effort = opts.reasoningEffort?.trim().toLowerCase();
  if (effort && VALID_CLAUDE_EFFORTS.has(effort)) {
    args.push('--effort', effort);
  }
  if (opts.permissionMode && VALID_CLAUDE_PERM_MODES.has(opts.permissionMode)) {
    args.push('--permission-mode', opts.permissionMode);
  }
  return args;
}

interface ActiveTurnState {
  runId: string;
  gotAnyDelta: boolean;
  onEvent: (ev: StreamEvent) => void;
  onComplete: () => void;
}

interface WarmClaudeWorker {
  shSessionId: string;
  nativeSessionId: string;
  configKey: string;
  transcriptPath?: string;
  lastTranscriptMtimeMs: number;
  proc: ChildProcess;
  stdoutBuf: string;
  stderrTail: string;
  activeTurn: ActiveTurnState | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * Persistent bidirectional pool of `claude --input-format stream-json --output-format stream-json`
 * workers — the exact same wire protocol Claude Desktop uses internally.
 *
 * Benefits over one-shot `claude -p --resume`:
 *  - Native multimodal base64 image blocks (no `[Attached image: ...]` workaround)
 *  - Warm sub-100ms subsequent turn latency without cold-starting Claude CLI
 *  - Automatic recycle if an external process modifies the transcript JSONL or
 *    when the user changes model / effort / permission mode
 *  - Clean mid-turn abort & idle cleanup
 */
export class ClaudeStreamPool {
  private workers = new Map<string, WarmClaudeWorker>(); // shSessionId -> worker

  constructor(private readonly parseStreamLine: ClaudeStreamLineHandler) {}

  hasWorker(shSessionId: string): boolean {
    return this.workers.has(shSessionId);
  }

  getWorkerPid(shSessionId: string): number | undefined {
    return this.workers.get(shSessionId)?.proc.pid;
  }

  hasActiveTurn(shSessionId: string): boolean {
    return Boolean(this.workers.get(shSessionId)?.activeTurn);
  }

  private getFileMtime(filePath?: string): number {
    if (!filePath) return 0;
    try {
      return fs.existsSync(filePath) ? fs.statSync(filePath).mtimeMs : 0;
    } catch {
      return 0;
    }
  }

  private scheduleIdleClose(worker: WarmClaudeWorker): void {
    if (worker.idleTimer) clearTimeout(worker.idleTimer);
    worker.idleTimer = setTimeout(() => {
      if (!worker.activeTurn) {
        this.closeWorker(worker.shSessionId);
      }
    }, WORKER_IDLE_TIMEOUT_MS);
  }

  private closeWorker(shSessionId: string): void {
    const w = this.workers.get(shSessionId);
    if (!w) return;
    if (w.idleTimer) clearTimeout(w.idleTimer);
    this.workers.delete(shSessionId);
    try {
      w.proc.stdin?.end();
    } catch {
      // ignore
    }
    try {
      w.proc.kill('SIGTERM');
    } catch {
      // ignore
    }
  }

  private spawnWorker(opts: {
    bin: string;
    shSessionId: string;
    nativeSessionId: string;
    cwd: string;
    model?: string;
    reasoningEffort?: string;
    permissionMode?: string;
    transcriptPath?: string;
    configKey: string;
  }): WarmClaudeWorker {
    const args = buildClaudeStreamWorkerArgs({
      nativeSessionId: opts.nativeSessionId,
      model: opts.model,
      reasoningEffort: opts.reasoningEffort,
      permissionMode: opts.permissionMode,
    });

    const proc = spawn(opts.bin, args, {
      cwd: opts.cwd,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const worker: WarmClaudeWorker = {
      shSessionId: opts.shSessionId,
      nativeSessionId: opts.nativeSessionId,
      configKey: opts.configKey,
      transcriptPath: opts.transcriptPath,
      lastTranscriptMtimeMs: this.getFileMtime(opts.transcriptPath),
      proc,
      stdoutBuf: '',
      stderrTail: '',
      activeTurn: null,
      idleTimer: null,
    };

    const handleLine = (rawLine: string) => {
      const trimmed = rawLine.trim();
      if (!trimmed) return;
      const turn = worker.activeTurn;
      if (!turn) return;

      if (this.parseStreamLine(worker.shSessionId, turn.runId, trimmed, turn.gotAnyDelta, turn.onEvent)) {
        turn.gotAnyDelta = true;
      }

      // Check for turn completion (`type === 'result'`)
      try {
        const obj = JSON.parse(trimmed) as { type?: string; is_error?: boolean; result?: unknown };
        if (obj.type === 'result') {
          if (obj.is_error && typeof obj.result === 'string' && obj.result.trim()) {
            turn.onEvent({
              sessionId: worker.shSessionId,
              runId: turn.runId,
              kind: 'error',
              error: obj.result.trim().slice(0, 1500),
            });
          }
          worker.activeTurn = null;
          worker.lastTranscriptMtimeMs = this.getFileMtime(worker.transcriptPath);
          turn.onEvent({ sessionId: worker.shSessionId, runId: turn.runId, kind: 'done' });
          turn.onComplete();
          this.scheduleIdleClose(worker);
        }
      } catch {
        // ignore non-JSON lines
      }
    };

    proc.stdout?.on('data', (chunk: Buffer) => {
      worker.stdoutBuf += chunk.toString('utf8');
      const lines = worker.stdoutBuf.split('\n');
      worker.stdoutBuf = lines.pop() ?? '';
      for (const line of lines) handleLine(line);
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      worker.stderrTail = (worker.stderrTail + chunk.toString('utf8')).slice(-2500);
    });

    proc.on('error', (err) => {
      if (this.workers.get(worker.shSessionId) === worker) {
        this.workers.delete(worker.shSessionId);
      }
      if (worker.idleTimer) clearTimeout(worker.idleTimer);
      const turn = worker.activeTurn;
      if (turn) {
        worker.activeTurn = null;
        turn.onEvent({
          sessionId: worker.shSessionId,
          runId: turn.runId,
          kind: 'error',
          error: err.message,
        });
        turn.onEvent({ sessionId: worker.shSessionId, runId: turn.runId, kind: 'done' });
        turn.onComplete();
      }
    });

    proc.on('close', (code) => {
      if (worker.stdoutBuf.trim()) handleLine(worker.stdoutBuf);
      if (this.workers.get(worker.shSessionId) === worker) {
        this.workers.delete(worker.shSessionId);
      }
      if (worker.idleTimer) clearTimeout(worker.idleTimer);
      const turn = worker.activeTurn;
      if (turn) {
        worker.activeTurn = null;
        if (code && code !== 0) {
          const errText = worker.stderrTail.trim() || `Claude exited with code ${code}`;
          turn.onEvent({
            sessionId: worker.shSessionId,
            runId: turn.runId,
            kind: 'error',
            error: errText.slice(0, 1500),
          });
        }
        turn.onEvent({ sessionId: worker.shSessionId, runId: turn.runId, kind: 'done' });
        turn.onComplete();
      }
    });

    this.workers.set(opts.shSessionId, worker);
    return worker;
  }

  async sendTurn(opts: {
    shSessionId: string;
    nativeSessionId: string;
    cwd: string;
    prompt: string;
    attachments?: ImageAttachment[];
    model?: string;
    reasoningEffort?: string;
    permissionMode?: string;
    transcriptPath?: string;
    runId: string;
    onEvent: (ev: StreamEvent) => void;
    onComplete: () => void;
  }): Promise<void> {
    const bin = await whichBinary('claude');
    if (!bin) throw new Error('claude binary not found in PATH');

    const safeCwd = fs.existsSync(opts.cwd) ? opts.cwd : os.homedir();
    const configKey = `${opts.model || ''}|${opts.reasoningEffort || ''}|${opts.permissionMode || ''}`;

    let worker = this.workers.get(opts.shSessionId);
    if (worker) {
      if (worker.activeTurn) {
        throw new Error(
          'This Claude session already has an active turn running in Super Harness. Wait for it to finish or queue your message.'
        );
      }
      const currentMtime = this.getFileMtime(opts.transcriptPath);
      const externallyUpdated =
        worker.lastTranscriptMtimeMs > 0 && currentMtime > worker.lastTranscriptMtimeMs + 500;
      const configChanged = worker.configKey !== configKey;
      const dead = worker.proc.killed || !worker.proc.stdin?.writable;

      if (externallyUpdated || configChanged || dead) {
        this.closeWorker(opts.shSessionId);
        worker = undefined;
      }
    }

    if (!worker) {
      worker = this.spawnWorker({
        bin,
        shSessionId: opts.shSessionId,
        nativeSessionId: opts.nativeSessionId,
        cwd: safeCwd,
        model: opts.model,
        reasoningEffort: opts.reasoningEffort,
        permissionMode: opts.permissionMode,
        transcriptPath: opts.transcriptPath,
        configKey,
      });
    }

    if (worker.idleTimer) {
      clearTimeout(worker.idleTimer);
      worker.idleTimer = null;
    }

    worker.activeTurn = {
      runId: opts.runId,
      gotAnyDelta: false,
      onEvent: opts.onEvent,
      onComplete: opts.onComplete,
    };
    opts.onEvent({ sessionId: opts.shSessionId, runId: opts.runId, kind: 'start' });

    const payload = buildClaudeStreamUserMessage(opts.prompt, opts.attachments);
    try {
      worker.proc.stdin!.write(`${JSON.stringify(payload)}\n`);
    } catch (err) {
      worker.activeTurn = null;
      this.closeWorker(opts.shSessionId);
      throw err;
    }
  }

  abort(shSessionId: string, emitStream: (ev: StreamEvent) => void): boolean {
    const worker = this.workers.get(shSessionId);
    if (!worker) return false;
    const turn = worker.activeTurn;
    worker.activeTurn = null;
    this.closeWorker(shSessionId);
    if (turn) {
      emitStream({ sessionId: shSessionId, runId: turn.runId, kind: 'done' });
      turn.onComplete();
    } else {
      emitStream({ sessionId: shSessionId, runId: 'abort', kind: 'done' });
    }
    return true;
  }

  closeAll(): void {
    for (const sid of Array.from(this.workers.keys())) {
      this.closeWorker(sid);
    }
  }
}
