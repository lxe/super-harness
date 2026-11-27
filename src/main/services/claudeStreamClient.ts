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
  // No synthesized prompt text: an image-only turn sends only image blocks.
  if (trimmed) {
    content.push({ type: 'text', text: trimmed });
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
    // Desktop's own host flags: route permission asks to this host over
    // stdio and stream partial messages as `stream_event` deltas.
    '--permission-prompt-tool',
    'stdio',
    '--include-partial-messages',
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

/**
 * Builds a host -> CLI control request frame, exactly as the Desktop SDK
 * host writes it (`initialize`, `interrupt`, `set_model`, …).
 */
export function buildClaudeControlRequest(
  requestId: string,
  request: Record<string, unknown>
): { type: 'control_request'; request_id: string; request: Record<string, unknown> } {
  return { type: 'control_request', request_id: requestId, request };
}

const PERMISSIVE_CLAUDE_MODES = new Set(['bypassPermissions', 'acceptEdits', 'auto', 'dontAsk']);

/**
 * Builds the response frame for a CLI -> host control request, mirroring
 * Claude Desktop's SDK host (`handleControlRequest` in its bundled JS):
 * success `{type:'control_response',response:{subtype:'success',request_id,response}}`,
 * error `{subtype:'error',request_id,error}`, and deliberate silence
 * (`null`) for `request_user_dialog` when no dialog handler exists.
 *
 * `can_use_tool`: Desktop prompts its user; Superharness has no permission
 * card on this lane, so permissive session modes allow and manual/plan
 * modes deny (fail-closed, same outcome as today's non-interactive runs).
 * `elicitation`: declined, Desktop's verbatim no-handler fallback.
 */
export function buildClaudeControlResponse(
  msg: Record<string, unknown>,
  permissionMode?: string
): Record<string, unknown> | null {
  const requestId = typeof msg.request_id === 'string' ? msg.request_id : '';
  const request = (msg.request ?? {}) as Record<string, unknown>;
  const subtype = typeof request.subtype === 'string' ? request.subtype : '';
  const success = (response: Record<string, unknown>) => ({
    type: 'control_response',
    response: { subtype: 'success', request_id: requestId, response },
  });
  switch (subtype) {
    case 'can_use_tool':
      return success(
        permissionMode && PERMISSIVE_CLAUDE_MODES.has(permissionMode)
          ? { behavior: 'allow' }
          : {
              behavior: 'deny',
              message:
                'Superharness cannot prompt for tool permission in this session mode; the tool call was denied.',
            }
      );
    case 'elicitation':
      return success({ action: 'decline' });
    case 'request_user_dialog':
      return null;
    default:
      return {
        type: 'control_response',
        response: {
          subtype: 'error',
          request_id: requestId,
          error: `Superharness does not handle ${subtype || 'unknown control request'}`,
        },
      };
  }
}

interface ActiveTurnState {
  runId: string;
  /** Per-segment flag: partial deltas streamed for the current block. */
  gotAnyDelta: boolean;
  /** Whole-turn flag: any text streamed (suppresses the result fallback). */
  anyDelta?: boolean;
  onEvent: (ev: StreamEvent) => void;
  onComplete: () => void;
}

interface WarmClaudeWorker {
  shSessionId: string;
  nativeSessionId: string;
  configKey: string;
  model?: string;
  reasoningEffort?: string;
  permissionMode?: string;
  transcriptPath?: string;
  lastTranscriptMtimeMs: number;
  proc: ChildProcess;
  stdoutBuf: string;
  stderrTail: string;
  activeTurn: ActiveTurnState | null;
  /** User frames submitted while busy; the CLI queues them natively in order. */
  queuedTurns: Array<{ turn: ActiveTurnState; payload: Record<string, unknown> }>;
  controlSeq: number;
  abortTimer: ReturnType<typeof setTimeout> | null;
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
    if (w.abortTimer) clearTimeout(w.abortTimer);
    this.settleQueuedTurns(w, 'Claude worker closed before the queued turn could run.');
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
      model: opts.model,
      reasoningEffort: opts.reasoningEffort,
      permissionMode: opts.permissionMode,
      transcriptPath: opts.transcriptPath,
      lastTranscriptMtimeMs: this.getFileMtime(opts.transcriptPath),
      proc,
      stdoutBuf: '',
      stderrTail: '',
      activeTurn: null,
      queuedTurns: [],
      controlSeq: 0,
      abortTimer: null,
      idleTimer: null,
    };

    const handleLine = (rawLine: string) => {
      const trimmed = rawLine.trim();
      if (!trimmed) return;

      let obj: { type?: string; is_error?: boolean; result?: unknown } | null = null;
      try {
        obj = JSON.parse(trimmed) as { type?: string; is_error?: boolean; result?: unknown };
      } catch {
        obj = null;
      }

      // CLI -> host control requests are answered even between turns.
      if (obj?.type === 'control_request') {
        const response = buildClaudeControlResponse(
          obj as Record<string, unknown>,
          worker.permissionMode
        );
        if (response) {
          try {
            proc.stdin?.write(`${JSON.stringify(response)}\n`);
          } catch {
            // worker is closing
          }
        }
        return;
      }
      if (obj?.type === 'control_response' || obj?.type === 'control_cancel_request') {
        return;
      }

      const turn = worker.activeTurn;
      if (!turn) return;

      const emitted = this.parseStreamLine(
        worker.shSessionId,
        turn.runId,
        trimmed,
        obj?.type === 'result' ? Boolean(turn.gotAnyDelta || turn.anyDelta) : turn.gotAnyDelta,
        turn.onEvent
      );
      if (emitted) turn.anyDelta = true;
      if (obj?.type === 'assistant') {
        // Segment boundary: partial deltas for the next block start fresh.
        turn.gotAnyDelta = false;
      } else if (emitted) {
        turn.gotAnyDelta = true;
      }

      if (obj?.type === 'result') {
        if (worker.abortTimer) {
          clearTimeout(worker.abortTimer);
          worker.abortTimer = null;
        }
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
        const next = worker.queuedTurns.shift();
        if (next) {
          worker.activeTurn = next.turn;
          next.turn.onEvent({
            sessionId: worker.shSessionId,
            runId: next.turn.runId,
            kind: 'start',
          });
          try {
            proc.stdin?.write(`${JSON.stringify(next.payload)}\n`);
          } catch {
            this.closeWorker(worker.shSessionId);
          }
        } else {
          this.scheduleIdleClose(worker);
        }
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
    // Desktop hosts open with the initialize control handshake.
    this.writeControl(worker, { subtype: 'initialize' });
    return worker;
  }

  private writeControl(worker: WarmClaudeWorker, request: Record<string, unknown>): void {
    try {
      worker.proc.stdin?.write(
        `${JSON.stringify(buildClaudeControlRequest(`sh-ctl-${++worker.controlSeq}`, request))}\n`
      );
    } catch {
      // worker is closing
    }
  }

  private settleQueuedTurns(worker: WarmClaudeWorker, error?: string): void {
    const queued = worker.queuedTurns.splice(0);
    for (const { turn } of queued) {
      if (error) {
        turn.onEvent({ sessionId: worker.shSessionId, runId: turn.runId, kind: 'error', error });
      }
      turn.onEvent({ sessionId: worker.shSessionId, runId: turn.runId, kind: 'done' });
      turn.onComplete();
    }
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
      const currentMtime = this.getFileMtime(opts.transcriptPath);
      const externallyUpdated =
        !worker.activeTurn &&
        worker.lastTranscriptMtimeMs > 0 &&
        currentMtime > worker.lastTranscriptMtimeMs + 500;
      const dead = worker.proc.killed || !worker.proc.stdin?.writable;

      if (dead) {
        this.closeWorker(opts.shSessionId);
        worker = undefined;
      } else if (externallyUpdated) {
        this.closeWorker(opts.shSessionId);
        worker = undefined;
      } else if (worker.configKey !== configKey) {
        // Model/permission changes go over the native control channel
        // (set_model / set_permission_mode) instead of a respawn; an effort
        // change still recycles (no wire subtype for it).
        if ((worker.reasoningEffort || '') !== (opts.reasoningEffort || '')) {
          if (!worker.activeTurn) {
            this.closeWorker(opts.shSessionId);
            worker = undefined;
          }
          // Busy: keep the worker; the new effort applies after recycle.
        } else {
          if ((worker.model || '') !== (opts.model || '') && opts.model?.trim()) {
            this.writeControl(worker, { subtype: 'set_model', model: opts.model.trim() });
            worker.model = opts.model;
          }
          if (
            (worker.permissionMode || '') !== (opts.permissionMode || '') &&
            opts.permissionMode &&
            VALID_CLAUDE_PERM_MODES.has(opts.permissionMode)
          ) {
            this.writeControl(worker, {
              subtype: 'set_permission_mode',
              mode: opts.permissionMode,
            });
            worker.permissionMode = opts.permissionMode;
          }
          if (worker) worker.configKey = configKey;
        }
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

    const turn: ActiveTurnState = {
      runId: opts.runId,
      gotAnyDelta: false,
      onEvent: opts.onEvent,
      onComplete: opts.onComplete,
    };
    const payload = buildClaudeStreamUserMessage(opts.prompt, opts.attachments);

    // Busy worker: submit into the native input queue (the CLI runs user
    // frames in FIFO order) instead of throwing.
    if (worker.activeTurn) {
      worker.queuedTurns.push({ turn, payload });
      return;
    }

    worker.activeTurn = turn;
    opts.onEvent({ sessionId: opts.shSessionId, runId: opts.runId, kind: 'start' });
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
    if (!worker.activeTurn && worker.queuedTurns.length === 0) {
      this.closeWorker(shSessionId);
      emitStream({ sessionId: shSessionId, runId: 'abort', kind: 'done' });
      return true;
    }
    this.settleQueuedTurns(worker);
    // Native interrupt over the control channel; the turn settles when the
    // CLI emits its result. Kill only if it does not settle promptly.
    this.writeControl(worker, { subtype: 'interrupt', cancel_queued: true });
    if (worker.abortTimer) clearTimeout(worker.abortTimer);
    worker.abortTimer = setTimeout(() => {
      worker.abortTimer = null;
      if (worker.activeTurn) this.closeWorker(shSessionId);
    }, 2500);
    return true;
  }

  closeAll(): void {
    for (const sid of Array.from(this.workers.keys())) {
      this.closeWorker(sid);
    }
  }
}
