import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { ImageAttachment, StreamEvent } from '../../shared/types';

export const DEFAULT_CODEX_DAEMON_SOCK = path.join(
  os.homedir(),
  '.codex',
  'app-server-control',
  'app-server-control.sock'
);

/**
 * Encodes a masked RFC 6455 client WebSocket frame (text=0x1, pong=0xa, close=0x8).
 */
export function encodeWsClientFrame(payload: Buffer, opcode = 0x1): Buffer {
  const len = payload.length;
  let headerLen = 2;
  if (len >= 126 && len < 65536) headerLen = 4;
  else if (len >= 65536) headerLen = 10;

  const out = Buffer.allocUnsafe(headerLen + 4 + len);
  out[0] = 0x80 | (opcode & 0x0f); // FIN=1
  if (len < 126) {
    out[1] = 0x80 | len;
  } else if (len < 65536) {
    out[1] = 0x80 | 126;
    out.writeUInt16BE(len, 2);
  } else {
    out[1] = 0x80 | 127;
    out.writeBigUInt64BE(BigInt(len), 2);
  }

  const mask = crypto.randomBytes(4);
  mask.copy(out, headerLen);
  const bodyStart = headerLen + 4;
  for (let i = 0; i < len; i++) {
    out[bodyStart + i] = payload[i] ^ mask[i & 3];
  }
  return out;
}

export interface DecodedWsFrame {
  opcode: number;
  payload: Buffer;
}

/**
 * Streaming RFC 6455 WebSocket frame decoder supporting split chunks,
 * coalesced frames, 16/64-bit lengths, fragmented continuation frames,
 * and control frames (ping/pong/close).
 */
export class WsFrameDecoder {
  private buf: Buffer = Buffer.alloc(0);
  private fragOpcode: number | null = null;
  private fragChunks: Buffer[] = [];

  push(chunk: Buffer): DecodedWsFrame[] {
    this.buf = this.buf.length > 0 ? Buffer.concat([this.buf, chunk]) : chunk;
    const frames: DecodedWsFrame[] = [];

    while (this.buf.length >= 2) {
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let payloadLen = b1 & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (this.buf.length < 4) break;
        payloadLen = this.buf.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (this.buf.length < 10) break;
        const bigLen = this.buf.readBigUInt64BE(2);
        if (bigLen > BigInt(64 * 1024 * 1024)) {
          throw new Error(`WebSocket frame too large: ${bigLen.toString()}`);
        }
        payloadLen = Number(bigLen);
        offset = 10;
      }

      const maskLen = masked ? 4 : 0;
      const totalLen = offset + maskLen + payloadLen;
      if (this.buf.length < totalLen) break;

      let payload = Buffer.from(this.buf.subarray(offset + maskLen, totalLen));
      if (masked) {
        const mask = this.buf.subarray(offset, offset + 4);
        for (let i = 0; i < payload.length; i++) {
          payload[i] ^= mask[i & 3];
        }
      }
      this.buf = this.buf.subarray(totalLen);

      // Control frames (ping/pong/close) are never fragmented
      if (opcode >= 0x8) {
        frames.push({ opcode, payload });
        continue;
      }

      if (opcode !== 0x0) {
        if (fin) {
          frames.push({ opcode, payload });
        } else {
          this.fragOpcode = opcode;
          this.fragChunks = [payload];
        }
      } else if (this.fragOpcode !== null) {
        this.fragChunks.push(payload);
        if (fin) {
          frames.push({
            opcode: this.fragOpcode,
            payload: Buffer.concat(this.fragChunks),
          });
          this.fragOpcode = null;
          this.fragChunks = [];
        }
      }
    }

    return frames;
  }
}

interface PendingRpc {
  resolve: (result: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ActiveTurnRun {
  shSessionId: string;
  nativeThreadId: string;
  runId: string;
  turnId?: string;
  onEvent: (ev: StreamEvent) => void;
  onComplete: () => void;
}

export interface CodexAppServerItemBlockMapper {
  (itemType: string, raw: Record<string, unknown>): {
    role: 'user' | 'assistant' | 'system';
    blocks: Array<NonNullable<StreamEvent['block']>>;
  };
}

/**
 * First-party JSON-RPC 2.0 WebSocket client talking directly to Codex's shared
 * `codex app-server` Unix-domain control socket — the exact same daemon that
 * Codex Desktop uses. Enables real-time, true bidirectional synchronization
 * (native `localImage` attachments, streaming deltas, `turn/interrupt`,
 * `thread/resume`, `thread/start`, `thread/archive`, and `thread/section/move`).
 */
export class CodexAppServerClient {
  private socket: Socket | null = null;
  private decoder = new WsFrameDecoder();
  private initialized = false;
  private connectPromise: Promise<void> | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRpc>();
  private resumedThreads = new Set<string>();
  private activeTurns = new Map<string, ActiveTurnRun>(); // nativeThreadId -> run

  constructor(
    private readonly socketPath: string = DEFAULT_CODEX_DAEMON_SOCK,
    private readonly mapItemToBlocks?: CodexAppServerItemBlockMapper,
    private readonly onDaemonActivity?: (threadId: string) => void
  ) {}

  isSocketAvailable(): boolean {
    try {
      return fs.existsSync(this.socketPath);
    } catch {
      return false;
    }
  }

  hasActiveTurn(nativeThreadId: string): boolean {
    return this.activeTurns.has(nativeThreadId);
  }

  private sendRawFrame(payload: Buffer, opcode = 0x1): void {
    if (!this.socket || this.socket.destroyed || !this.socket.writable) {
      throw new Error('Codex app-server socket not connected');
    }
    this.socket.write(encodeWsClientFrame(payload, opcode));
  }

  private sendJson(obj: Record<string, unknown>): void {
    this.sendRawFrame(Buffer.from(JSON.stringify(obj), 'utf8'), 0x1);
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = 20_000
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`Codex app-server RPC timeout (${method})`));
        }
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.sendJson({ jsonrpc: '2.0', id, method, params });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  async ensureConnected(): Promise<void> {
    if (this.socket && !this.socket.destroyed && this.initialized) return;
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = (async () => {
      if (!this.isSocketAvailable()) {
        throw new Error(`Codex app-server socket not found: ${this.socketPath}`);
      }

      const sock = await new Promise<Socket>((resolve, reject) => {
        const key = crypto.randomBytes(16).toString('base64');
        const req = http.request({
          socketPath: this.socketPath,
          path: '/',
          headers: {
            Connection: 'Upgrade',
            Upgrade: 'websocket',
            'Sec-WebSocket-Key': key,
            'Sec-WebSocket-Version': '13',
          },
        });
        const connectTimer = setTimeout(() => {
          req.destroy(new Error('Codex app-server WebSocket upgrade timed out'));
        }, 5000);

        req.on('upgrade', (_res, upgradedSocket, head) => {
          clearTimeout(connectTimer);
          this.socket = upgradedSocket;
          this.decoder = new WsFrameDecoder();
          this.initialized = false;
          this.resumedThreads.clear();

          upgradedSocket.on('data', (chunk: Buffer) => this.handleChunk(chunk));
          upgradedSocket.on('close', () => this.handleDisconnect('socket closed'));
          upgradedSocket.on('error', (err) => this.handleDisconnect(err.message));

          if (head && head.length > 0) {
            this.handleChunk(head);
          }
          resolve(upgradedSocket);
        });
        req.on('response', (res) => {
          clearTimeout(connectTimer);
          reject(new Error(`Codex app-server rejected WebSocket upgrade (HTTP ${res.statusCode})`));
        });
        req.on('error', (err) => {
          clearTimeout(connectTimer);
          reject(err);
        });
        req.end();
      });

      void sock;
      await this.request(
        'initialize',
        {
          clientInfo: {
            name: 'super-harness',
            title: 'Super Harness',
            version: '0.1.0',
          },
          capabilities: {
            experimentalApi: true,
            requestAttestation: false,
          },
        },
        8000
      );
      this.sendJson({ jsonrpc: '2.0', method: 'initialized' });
      this.initialized = true;
    })();

    try {
      await this.connectPromise;
    } catch (err) {
      this.close();
      throw err;
    } finally {
      this.connectPromise = null;
    }
  }

  private handleDisconnect(reason: string): void {
    this.socket = null;
    this.initialized = false;
    this.resumedThreads.clear();

    const err = new Error(`Codex app-server disconnected (${reason})`);
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();

    for (const run of this.activeTurns.values()) {
      run.onEvent({
        sessionId: run.shSessionId,
        runId: run.runId,
        kind: 'done',
      });
      run.onComplete();
    }
    this.activeTurns.clear();
  }

  private handleChunk(chunk: Buffer): void {
    let frames: DecodedWsFrame[];
    try {
      frames = this.decoder.push(chunk);
    } catch (err) {
      this.handleDisconnect(err instanceof Error ? err.message : String(err));
      return;
    }

    for (const frame of frames) {
      if (frame.opcode === 0x9) {
        // Ping -> Pong
        try {
          this.sendRawFrame(frame.payload, 0xa);
        } catch {
          // ignore
        }
        continue;
      }
      if (frame.opcode === 0x8) {
        this.close();
        return;
      }
      if (frame.opcode !== 0x1) continue;

      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(frame.payload.toString('utf8')) as Record<string, unknown>;
      } catch {
        continue;
      }
      this.handleMessage(msg);
    }
  }

  private handleMessage(msg: Record<string, unknown>): void {
    // 1. Response to one of our JSON-RPC requests
    if (typeof msg.id === 'number' && !msg.method) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      if (msg.error) {
        const e = msg.error as Record<string, unknown>;
        p.reject(new Error(String(e.message || JSON.stringify(e))));
      } else {
        p.resolve((msg.result ?? {}) as Record<string, unknown>);
      }
      return;
    }

    // 2. Server -> Client notification (live bidirectional events from shared daemon!)
    const method = typeof msg.method === 'string' ? msg.method : '';
    const params = (msg.params ?? {}) as Record<string, unknown>;
    const threadId = typeof params.threadId === 'string' ? params.threadId : '';

    if (
      threadId &&
      (method === 'turn/started' ||
        method === 'turn/completed' ||
        method === 'item/completed' ||
        method === 'thread/archived')
    ) {
      this.onDaemonActivity?.(threadId);
    }

    if (!threadId) return;
    const run = this.activeTurns.get(threadId);
    if (!run) return;

    if (method === 'turn/started') {
      const turn = params.turn as Record<string, unknown> | undefined;
      if (typeof turn?.id === 'string' && turn.id) {
        run.turnId = turn.id;
      }
      return;
    }

    if (method === 'item/agentMessage/delta') {
      const delta = typeof params.delta === 'string' ? params.delta : '';
      if (delta) {
        run.onEvent({
          sessionId: run.shSessionId,
          runId: run.runId,
          kind: 'delta',
          text: delta,
        });
      }
      return;
    }

    if (method === 'item/completed') {
      const item = params.item as Record<string, unknown> | undefined;
      const itemType = typeof item?.type === 'string' ? item.type : '';
      if (item && itemType && itemType !== 'agentMessage' && itemType !== 'userMessage') {
        if (this.mapItemToBlocks) {
          const { blocks } = this.mapItemToBlocks(itemType, item);
          for (const block of blocks) {
            run.onEvent({
              sessionId: run.shSessionId,
              runId: run.runId,
              kind: 'block',
              block,
            });
          }
        }
      }
      return;
    }

    if (method === 'turn/completed') {
      const turn = params.turn as Record<string, unknown> | undefined;
      const errObj = turn?.error as Record<string, unknown> | undefined;
      if (turn?.status === 'failed' && errObj?.message) {
        run.onEvent({
          sessionId: run.shSessionId,
          runId: run.runId,
          kind: 'error',
          error: String(errObj.message),
        });
      }
      this.activeTurns.delete(threadId);
      run.onEvent({
        sessionId: run.shSessionId,
        runId: run.runId,
        kind: 'done',
      });
      run.onComplete();
    }
  }

  static buildUserInputs(
    prompt: string,
    attachments?: ImageAttachment[]
  ): Array<Record<string, unknown>> {
    const inputs: Array<Record<string, unknown>> = [];
    if (attachments && attachments.length > 0) {
      for (const att of attachments) {
        if (att.path) {
          inputs.push({ type: 'localImage', path: att.path });
        }
      }
    }
    const trimmed = prompt.trim();
    if (trimmed) {
      inputs.push({ type: 'text', text: trimmed, text_elements: [] });
    } else if (inputs.length > 0) {
      inputs.push({
        type: 'text',
        text: 'Inspect the attached image(s).',
        text_elements: [],
      });
    }
    return inputs;
  }

  async startThread(opts: {
    cwd: string;
    model?: string;
    reasoningEffort?: string;
  }): Promise<string> {
    await this.ensureConnected();
    const params: Record<string, unknown> = {
      cwd: opts.cwd,
    };
    if (opts.model) params.model = opts.model;
    if (opts.reasoningEffort) {
      params.config = { model_reasoning_effort: opts.reasoningEffort };
    }
    const res = await this.request('thread/start', params);
    const thread = res.thread as Record<string, unknown> | undefined;
    const threadId = typeof thread?.id === 'string' ? thread.id : '';
    if (!threadId) {
      throw new Error('Codex app-server thread/start did not return a thread id');
    }
    this.resumedThreads.add(threadId);
    return threadId;
  }

  async sendTurn(opts: {
    shSessionId: string;
    nativeThreadId: string;
    cwd: string;
    prompt: string;
    attachments?: ImageAttachment[];
    model?: string;
    reasoningEffort?: string;
    runId: string;
    onEvent: (ev: StreamEvent) => void;
    onComplete: () => void;
  }): Promise<{ turnId?: string }> {
    await this.ensureConnected();

    if (!this.resumedThreads.has(opts.nativeThreadId)) {
      await this.request('thread/resume', {
        threadId: opts.nativeThreadId,
      });
      this.resumedThreads.add(opts.nativeThreadId);
    }

    const input = CodexAppServerClient.buildUserInputs(opts.prompt, opts.attachments);
    const turnParams: Record<string, unknown> = {
      threadId: opts.nativeThreadId,
      input,
      cwd: opts.cwd,
    };
    if (opts.model) turnParams.model = opts.model;
    if (opts.reasoningEffort) turnParams.effort = opts.reasoningEffort;

    const run: ActiveTurnRun = {
      shSessionId: opts.shSessionId,
      nativeThreadId: opts.nativeThreadId,
      runId: opts.runId,
      onEvent: opts.onEvent,
      onComplete: opts.onComplete,
    };
    this.activeTurns.set(opts.nativeThreadId, run);
    opts.onEvent({ sessionId: opts.shSessionId, runId: opts.runId, kind: 'start' });

    try {
      const res = await this.request('turn/start', turnParams, 25_000);
      const turn = res.turn as Record<string, unknown> | undefined;
      const turnId = typeof turn?.id === 'string' ? turn.id : undefined;
      if (turnId) run.turnId = turnId;
      return { turnId };
    } catch (err) {
      this.activeTurns.delete(opts.nativeThreadId);
      this.resumedThreads.delete(opts.nativeThreadId);
      throw err;
    }
  }

  async steerTurn(
    nativeThreadId: string,
    prompt: string,
    attachments?: ImageAttachment[]
  ): Promise<boolean> {
    try {
      await this.ensureConnected();
      if (!this.resumedThreads.has(nativeThreadId)) {
        try {
          await this.request('thread/resume', { threadId: nativeThreadId }, 5_000);
          this.resumedThreads.add(nativeThreadId);
        } catch {
          // Proceed to thread/read + turn/steer anyway
        }
      }
      let expectedTurnId = this.activeTurns.get(nativeThreadId)?.turnId;
      if (!expectedTurnId) {
        // Also support steering turns started externally (e.g. from Codex Desktop)
        try {
          const readRes = await this.request(
            'thread/read',
            { threadId: nativeThreadId, includeTurns: true },
            5_000
          );
          const thread = readRes.thread as Record<string, unknown> | undefined;
          const turns = Array.isArray(thread?.turns)
            ? (thread.turns as Array<Record<string, unknown>>)
            : [];
          const active = [...turns]
            .reverse()
            .find((t) => String(t.status || '').toLowerCase() === 'inprogress');
          if (typeof active?.id === 'string' && active.id) {
            expectedTurnId = active.id;
          }
        } catch {
          // Ignore if thread/read fails
        }
      }
      if (!expectedTurnId) return false;
      const input = CodexAppServerClient.buildUserInputs(prompt, attachments);
      await this.request(
        'turn/steer',
        {
          threadId: nativeThreadId,
          expectedTurnId,
          input,
        },
        10_000
      );
      return true;
    } catch {
      return false;
    }
  }

  async interruptTurn(nativeThreadId: string): Promise<boolean> {
    const run = this.activeTurns.get(nativeThreadId);
    if (!run || !run.turnId) return false;
    try {
      await this.ensureConnected();
      await this.request('turn/interrupt', {
        threadId: nativeThreadId,
        turnId: run.turnId,
      });
      return true;
    } catch {
      return false;
    }
  }

  async archiveThread(nativeThreadId: string): Promise<boolean> {
    try {
      await this.ensureConnected();
      await this.request('thread/archive', { threadId: nativeThreadId });
      this.resumedThreads.delete(nativeThreadId);
      return true;
    } catch {
      return false;
    }
  }

  async moveThreadToSectionByName(
    nativeThreadId: string,
    sectionName: string | null
  ): Promise<boolean> {
    try {
      await this.ensureConnected();
      let targetSectionId: string | null = null;
      if (sectionName && sectionName !== 'Ungrouped') {
        const listRes = await this.request('threadSection/list', {});
        const sections = Array.isArray(listRes.sections)
          ? (listRes.sections as Array<Record<string, unknown>>)
          : Array.isArray(listRes.data)
            ? (listRes.data as Array<Record<string, unknown>>)
            : [];
        const match = sections.find(
          (s) =>
            typeof s.name === 'string' &&
            s.name.trim().toLowerCase() === sectionName.trim().toLowerCase()
        );
        if (!match || typeof match.id !== 'string') return false;
        targetSectionId = match.id;
      }
      await this.request('thread/section/move', {
        threadId: nativeThreadId,
        sectionId: targetSectionId,
      });
      return true;
    } catch {
      return false;
    }
  }

  close(): void {
    try {
      this.socket?.destroy();
    } catch {
      // ignore
    }
    this.socket = null;
    this.initialized = false;
    this.resumedThreads.clear();
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('Codex app-server client closed'));
    }
    this.pending.clear();
    this.activeTurns.clear();
  }
}
