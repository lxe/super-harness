import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import type { Readable, Writable } from 'node:stream';
import type {
  ImageAttachment,
  LiveStepItem,
  StreamEvent,
  UnifiedBlock,
  UnifiedMessage,
} from '../../shared/types';
import { createUniqueIdGenerator } from '../adapters/types';

/**
 * Native MSP (Muse Session Protocol) v1 client — the exact wire Muse's own
 * session clients speak (`muse serve` hosts, `muse attach --stdio` bridges).
 *
 * Transport (probed against Muse 1.4.25 `muse serve --provider echo`):
 * newline-delimited JSON-RPC 2.0, one frame per LF-terminated line on stdio;
 * Content-Length framing is rejected with -32700 parseError. User turns are
 * submitted with `turn/start` on the host that holds the session, history is
 * the host-folded `Item[]` from `session/read`/`session/resume`, and live
 * updates arrive as `item/*` / `turn/*` notifications. There is no peer or
 * sender metadata on this lane — a submitted turn is indistinguishable from
 * one typed in a Muse client.
 *
 * Sessions held by a plain terminal (`muse sessions --json` reports
 * `attachable:false`) expose no attach endpoint: `muse attach --stdio`
 * exits 4 and a foreign host answers resume/turn with -32021 sessionInUse.
 * Callers must degrade honestly (refuse dispatch, read-only mirror) instead
 * of falling back to peer messaging or headless double-driving.
 */

export interface MspItem {
  itemId: string;
  kind: string;
  revision?: number;
  turnId?: string | null;
  status?: string;
  text?: string;
  displayText?: string;
  summary?: string[];
  tool?: string;
  args?: string;
  result?: unknown;
  visibleOutput?: string;
  commandText?: string;
  exitCode?: number;
  fallbackText?: string;
  label?: string;
  recordedAt?: string | number;
  attachments?: Array<Record<string, unknown>>;
  peerMessage?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export type MspFrame = Record<string, unknown>;

/** Encodes one JSON-RPC frame as a single LF-terminated NDJSON line. */
export function encodeMspFrame(frame: MspFrame): string {
  return `${JSON.stringify(frame)}\n`;
}

/** Parses one NDJSON line; returns null for blank/non-JSON noise lines. */
export function decodeMspLine(line: string): MspFrame | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as MspFrame) : null;
  } catch {
    return null;
  }
}

/** Incremental NDJSON decoder over arbitrary stdio chunk boundaries. */
export class MspNdjsonDecoder {
  private buffer = '';

  push(chunk: string): MspFrame[] {
    this.buffer += chunk;
    const frames: MspFrame[] = [];
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      const frame = decodeMspLine(line);
      if (frame) frames.push(frame);
    }
    return frames;
  }
}

/**
 * Mints a UUIDv7 (MSP commandIds are UUIDv7 idempotency handles; Node's
 * `crypto.randomUUID()` is v4).
 */
export function uuidv7(nowMs: number = Date.now()): string {
  const bytes = crypto.randomBytes(16);
  const ms = BigInt(nowMs);
  bytes[0] = Number((ms >> 40n) & 0xffn);
  bytes[1] = Number((ms >> 32n) & 0xffn);
  bytes[2] = Number((ms >> 24n) & 0xffn);
  bytes[3] = Number((ms >> 16n) & 0xffn);
  bytes[4] = Number((ms >> 8n) & 0xffn);
  bytes[5] = Number(ms & 0xffn);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** MSP `initialize` client names must match `^[a-z0-9_]+$`. */
export function isValidMspClientName(name: string): boolean {
  return /^[a-z0-9_]+$/.test(name);
}

export type MspErrorKind =
  | 'session-in-use'
  | 'session-not-loaded'
  | 'missing-run'
  | 'method-not-found'
  | 'not-initialized'
  | 'other';

export class MspRpcError extends Error {
  readonly code?: number;
  readonly data?: unknown;
  readonly kind: MspErrorKind;

  constructor(message: string, code?: number, data?: unknown) {
    super(message);
    this.name = 'MspRpcError';
    this.code = code;
    this.data = data;
    this.kind = classifyMspError({ code, message, data });
  }
}

/** Classifies an MSP JSON-RPC error object (or any thrown value) by code. */
export function classifyMspError(err: unknown): MspErrorKind {
  const raw = err as { code?: unknown; error?: { code?: unknown } } | null;
  const code =
    typeof raw?.code === 'number'
      ? raw.code
      : typeof raw?.error?.code === 'number'
        ? raw.error.code
        : undefined;
  switch (code) {
    case -32021:
      return 'session-in-use';
    case -32024:
      return 'session-not-loaded';
    case -32030:
      return 'missing-run';
    case -32601:
      return 'method-not-found';
    case -32002:
      return 'not-initialized';
    default:
      return 'other';
  }
}

const IMAGE_MEDIA_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/**
 * Builds `turn/start` input parts: image parts (base64 read from disk, the
 * host never echoes payloads back) followed by the text part. No prompt
 * text is ever synthesized — an image-only turn sends only image parts.
 */
export function buildMuseTurnInputs(
  prompt: string,
  attachments?: ImageAttachment[]
): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = [];
  for (const att of attachments ?? []) {
    if (!att.path) continue;
    const base64Data = fs.readFileSync(att.path).toString('base64');
    const mediaType =
      att.mimeType ||
      IMAGE_MEDIA_BY_EXT[att.path.slice(att.path.lastIndexOf('.')).toLowerCase()] ||
      'image/png';
    parts.push({ type: 'image', mediaType, base64Data });
  }
  if (prompt.trim()) parts.push({ type: 'text', text: prompt });
  return parts;
}

/** Extracts folded items from a `SessionHistory` envelope (inline or snapshot). */
export function extractMspHistoryItems(history: unknown): MspItem[] {
  if (!history || typeof history !== 'object') return [];
  const h = history as Record<string, unknown>;
  if (Array.isArray(h.items)) return h.items as MspItem[];
  const snapshot = h.snapshot as Record<string, unknown> | null | undefined;
  const state = snapshot?.state as Record<string, unknown> | undefined;
  if (Array.isArray(state?.items)) return state.items as MspItem[];
  return [];
}

function parseItemArgs(item: MspItem): Record<string, unknown> {
  if (typeof item.args !== 'string') return {};
  try {
    const parsed = JSON.parse(item.args) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function itemResultText(item: MspItem): string | undefined {
  if (typeof item.visibleOutput === 'string' && item.visibleOutput) {
    return item.visibleOutput.slice(0, 60_000);
  }
  if (typeof item.result === 'string' && item.result) return item.result.slice(0, 60_000);
  return undefined;
}

function mapToolCallItem(item: MspItem): UnifiedBlock {
  const argsObj = parseItemArgs(item);
  const name = item.tool || 'tool';
  const output = itemResultText(item);
  const status = item.status && item.status !== 'inProgress' ? item.status : 'running';
  if (name === 'bash' && typeof argsObj.command === 'string') {
    return {
      type: 'command',
      command: argsObj.command,
      cwd: typeof argsObj.workdir === 'string' ? argsObj.workdir : undefined,
      output,
      status,
    };
  }
  if (name === 'request_user_input' && Array.isArray(argsObj.questions)) {
    return {
      type: 'question',
      questions: (argsObj.questions as Array<Record<string, unknown>>)
        .filter((q) => q && typeof q.question === 'string')
        .map((q) => ({
          question: String(q.question),
          options: (Array.isArray(q.options) ? q.options : [])
            .map((o) => {
              const opt = o as Record<string, unknown>;
              return typeof opt?.label === 'string' ? opt.label : typeof o === 'string' ? o : '';
            })
            .filter(Boolean),
          multiSelect:
            (q.selection as Record<string, unknown> | undefined)?.mode === 'multiple',
        })),
    };
  }
  return {
    type: 'tool_call',
    name,
    args: typeof item.args === 'string' ? item.args.slice(0, 4000) : undefined,
    output,
    status,
  };
}

function peerMessageText(item: MspItem): string {
  const peer = item.peerMessage;
  if (peer && typeof peer === 'object') {
    for (const key of ['body', 'displayBody', 'text', 'summary']) {
      const v = (peer as Record<string, unknown>)[key];
      if (typeof v === 'string' && v.trim()) return v;
    }
  }
  return item.text || item.fallbackText || '';
}

function itemTimestamp(item: MspItem, fallback: number): number {
  const raw = item.recordedAt;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    // Epoch microseconds vs milliseconds: µs values are ~1e15+.
    return raw > 1e14 ? Math.floor(raw / 1000) : Math.floor(raw);
  }
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

/**
 * Folds host `Item[]` (session/read|resume history) into the unified
 * transcript. `userMessage` starts a turn; following agent-side items
 * coalesce into one assistant message. `peerMessage` keeps the host's own
 * distinction (agent-sourced, never shown as human typing). Unknown kinds
 * render generically from `fallbackText` per MSP SS4.10.
 */
export function foldMspItems(items: MspItem[], fallbackTs: number = Date.now()): UnifiedMessage[] {
  const messages: UnifiedMessage[] = [];
  const uniqueId = createUniqueIdGenerator();
  let currentAssistant: UnifiedMessage | null = null;

  const ensureAssistant = (item: MspItem): UnifiedMessage => {
    if (!currentAssistant) {
      currentAssistant = {
        id: uniqueId(`msp-a-${item.turnId ?? item.itemId}`),
        role: 'assistant',
        timestamp: itemTimestamp(item, fallbackTs),
        blocks: [],
        harnessMeta: {
          turnId: typeof item.turnId === 'string' ? item.turnId : undefined,
          sourceKind: 'agent',
        },
      };
      messages.push(currentAssistant);
    }
    return currentAssistant;
  };

  for (const item of items) {
    if (!item || typeof item.kind !== 'string') continue;
    const ts = itemTimestamp(item, fallbackTs);
    switch (item.kind) {
      case 'userMessage': {
        currentAssistant = null;
        const text = item.text || item.displayText || '';
        const blocks: UnifiedBlock[] = [];
        if (text) blocks.push({ type: 'text', text });
        if (blocks.length === 0) continue;
        messages.push({
          id: uniqueId(`msp-u-${item.itemId}`),
          role: 'user',
          timestamp: ts,
          blocks,
          harnessMeta: { sourceKind: 'human' },
        });
        break;
      }
      case 'peerMessage': {
        currentAssistant = null;
        const text = peerMessageText(item);
        if (!text) continue;
        messages.push({
          id: uniqueId(`msp-p-${item.itemId}`),
          role: 'user',
          timestamp: ts,
          blocks: [{ type: 'text', text }],
          harnessMeta: { sourceKind: 'agent' },
        });
        break;
      }
      case 'userShell': {
        currentAssistant = null;
        messages.push({
          id: uniqueId(`msp-s-${item.itemId}`),
          role: 'user',
          timestamp: ts,
          blocks: [
            {
              type: 'command',
              command: item.commandText || '',
              output: itemResultText(item),
              exitCode: typeof item.exitCode === 'number' ? item.exitCode : undefined,
            },
          ],
          harnessMeta: { sourceKind: 'human' },
        });
        break;
      }
      case 'agentMessage': {
        if (item.text?.trim()) {
          ensureAssistant(item).blocks.push({ type: 'text', text: item.text });
        }
        break;
      }
      case 'reasoning': {
        const text = (item.summary ?? []).filter(Boolean).join('\n') || item.text || '';
        if (text.trim()) ensureAssistant(item).blocks.push({ type: 'thinking', text });
        break;
      }
      case 'toolCall': {
        ensureAssistant(item).blocks.push(mapToolCallItem(item));
        break;
      }
      case 'subagent':
      case 'workflow':
      case 'reminderChild':
      case 'sideChat':
      case 'subagentInput':
      case 'subagentResult': {
        // Native trace rows (child sessions / workflows): fold into the
        // assistant trace like a tool call instead of a system notice.
        ensureAssistant(item).blocks.push({
          type: 'tool_call',
          name: item.kind,
          args:
            typeof item.objective === 'string'
              ? item.objective
              : typeof item.args === 'string'
                ? item.args.slice(0, 4000)
                : undefined,
          output: itemResultText(item) || item.fallbackText,
          status: item.status && item.status !== 'inProgress' ? item.status : 'running',
        });
        break;
      }
      case 'webSearch': {
        ensureAssistant(item).blocks.push({
          type: 'web_search',
          query: item.text || item.fallbackText || 'web search',
        });
        break;
      }
      case 'compaction': {
        currentAssistant = null;
        const text = item.text || item.fallbackText || '';
        if (!text) continue;
        messages.push({
          id: uniqueId(`msp-c-${item.itemId}`),
          role: 'user',
          timestamp: ts,
          blocks: [{ type: 'text', text }],
          harnessMeta: { sourceKind: 'compaction' },
        });
        break;
      }
      default: {
        const detail = item.fallbackText || item.text || item.label || '';
        if (!detail) continue;
        messages.push({
          id: uniqueId(`msp-n-${item.itemId}`),
          role: 'system',
          timestamp: ts,
          blocks: [{ type: 'notice', title: item.kind, detail }],
          harnessMeta: { sourceKind: 'system_meta' },
        });
        break;
      }
    }
  }
  return messages;
}

/**
 * Live item store implementing the MSP apply rule: `item/started|updated|
 * completed` replace iff the incoming `revision` is higher; `item/delta`
 * appends to a field (`text`, `summary.n`, `output`) without a revision bump.
 */
export function createMspItemStore(): {
  applyItem(item: MspItem): void;
  applyDelta(itemId: string, field: string, delta: string): void;
  items(): MspItem[];
  get(itemId: string): MspItem | undefined;
} {
  const byId = new Map<string, MspItem>();
  const order: string[] = [];
  return {
    applyItem(item: MspItem): void {
      if (!item?.itemId) return;
      const existing = byId.get(item.itemId);
      if (!existing) {
        byId.set(item.itemId, { ...item });
        order.push(item.itemId);
        return;
      }
      const nextRev = typeof item.revision === 'number' ? item.revision : 0;
      const curRev = typeof existing.revision === 'number' ? existing.revision : 0;
      if (nextRev >= curRev) byId.set(item.itemId, { ...existing, ...item });
    },
    applyDelta(itemId: string, field: string, delta: string): void {
      const existing = byId.get(itemId);
      if (!existing || typeof delta !== 'string') return;
      if (field === 'text' || field === 'output') {
        const cur = typeof existing[field] === 'string' ? (existing[field] as string) : '';
        existing[field] = cur + delta;
      } else if (field.startsWith('summary.')) {
        const idx = Number(field.slice('summary.'.length));
        if (!Number.isInteger(idx) || idx < 0) return;
        const summary = Array.isArray(existing.summary) ? [...existing.summary] : [];
        summary[idx] = (summary[idx] ?? '') + delta;
        existing.summary = summary;
      }
    },
    items(): MspItem[] {
      return order.map((id) => byId.get(id)!).filter(Boolean);
    },
    get(itemId: string): MspItem | undefined {
      return byId.get(itemId);
    },
  };
}

export function mapMspTodoItems(raw: unknown): LiveStepItem[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const steps = raw
    .filter(
      (it): it is Record<string, unknown> =>
        Boolean(it) && typeof it === 'object' && typeof (it as Record<string, unknown>).text === 'string'
    )
    .map((it) => {
      const status = String(it.status || 'pending');
      return {
        title: String(it.text),
        status: (status === 'completed'
          ? 'done'
          : status === 'in_progress'
            ? 'in_progress'
            : status === 'cancelled'
              ? 'skipped'
              : 'pending') as LiveStepItem['status'],
      };
    });
  return steps.length > 0 ? steps : undefined;
}

interface PendingRequest {
  resolve: (result: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ActiveMspRun {
  shSessionId: string;
  nativeSessionId: string;
  runId: string;
  turnId?: string;
  gotDelta: boolean;
  onEvent: (ev: StreamEvent) => void;
  onComplete: () => void;
}

export interface MuseMspConnectionOptions {
  input: Writable;
  output: Readable;
  clientName?: string;
  clientVersion?: string;
  /** Forwarded host notifications (session/todoListChanged, session/*, …). */
  onNotification?: (method: string, params: Record<string, unknown>) => void;
  onClose?: () => void;
}

/**
 * One MSP JSON-RPC connection over a stdio pair. Handles the initialize
 * handshake, request/response correlation, server-request presentation
 * receipts (`{}` per SS5.3.3 — decisions only ever come from real UI), and
 * turn lifecycle streaming (`item/delta` → delta events, `turn/completed`
 * → done).
 */
export class MuseMspConnection {
  private readonly input: Writable;
  private readonly decoder = new MspNdjsonDecoder();
  private readonly pending = new Map<number, PendingRequest>();
  private readonly resumedSessions = new Set<string>();
  private readonly activeRuns = new Map<string, ActiveMspRun>();
  private readonly itemKinds = new Map<string, string>();
  private nextId = 1;
  private initPromise: Promise<void> | null = null;
  private closed = false;

  constructor(private readonly opts: MuseMspConnectionOptions) {
    this.input = opts.input;
    opts.output.on('data', (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      for (const frame of this.decoder.push(text)) this.handleFrame(frame);
    });
    opts.output.on('close', () => this.handleClose());
    opts.output.on('end', () => this.handleClose());
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Muse MSP host connection closed'));
    }
    this.pending.clear();
    for (const [, run] of this.activeRuns) {
      run.onEvent({ sessionId: run.shSessionId, runId: run.runId, kind: 'done' });
      run.onComplete();
    }
    this.activeRuns.clear();
    this.resumedSessions.clear();
    this.opts.onClose?.();
  }

  close(): void {
    try {
      this.input.end();
    } catch {
      // already ended
    }
    this.handleClose();
  }

  private write(frame: MspFrame): void {
    this.input.write(encodeMspFrame(frame));
  }

  private handleFrame(frame: MspFrame): void {
    const hasId = frame.id !== undefined && frame.id !== null;
    const method = typeof frame.method === 'string' ? frame.method : undefined;

    // Response to one of our requests.
    if (hasId && !method) {
      const id = typeof frame.id === 'number' ? frame.id : Number(frame.id);
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (frame.error && typeof frame.error === 'object') {
        const err = frame.error as Record<string, unknown>;
        pending.reject(
          new MspRpcError(
            typeof err.message === 'string' ? err.message : 'Muse MSP request failed',
            typeof err.code === 'number' ? err.code : undefined,
            err.data
          )
        );
      } else {
        pending.resolve(
          frame.result && typeof frame.result === 'object'
            ? (frame.result as Record<string, unknown>)
            : {}
        );
      }
      return;
    }

    if (!method) return;
    const params =
      frame.params && typeof frame.params === 'object'
        ? (frame.params as Record<string, unknown>)
        : {};

    // Server-initiated request (approval/request, userInput/request):
    // answer with the SS5.3.3 presentation receipt. Decisions/answers are
    // separate commands a real UI sends; this connection never auto-decides.
    if (hasId) {
      this.write({ jsonrpc: '2.0', id: frame.id, result: {} });
      this.opts.onNotification?.(method, params);
      return;
    }

    this.handleNotification(method, params);
  }

  private handleNotification(method: string, params: Record<string, unknown>): void {
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId : undefined;
    const run = sessionId ? this.activeRuns.get(sessionId) : undefined;

    if (method === 'item/started' || method === 'item/updated' || method === 'item/completed') {
      const item = params.item as MspItem | undefined;
      if (item?.itemId) this.itemKinds.set(item.itemId, item.kind);
      if (run && item && method === 'item/completed') {
        if (item.kind === 'agentMessage' && !run.gotDelta && item.text) {
          run.gotDelta = true;
          run.onEvent({ sessionId: run.shSessionId, runId: run.runId, kind: 'delta', text: item.text });
        } else if (item.kind === 'toolCall') {
          run.onEvent({
            sessionId: run.shSessionId,
            runId: run.runId,
            kind: 'block',
            block: mapToolCallItem(item),
          });
        } else if (item.kind === 'reasoning') {
          const text = (item.summary ?? []).filter(Boolean).join('\n') || item.text || '';
          if (text.trim()) {
            run.onEvent({
              sessionId: run.shSessionId,
              runId: run.runId,
              kind: 'block',
              block: { type: 'thinking', text },
            });
          }
        }
      }
    } else if (method === 'item/delta' && run) {
      const field = typeof params.field === 'string' ? params.field : '';
      const itemId = typeof params.itemId === 'string' ? params.itemId : '';
      const kind = this.itemKinds.get(itemId);
      if (field === 'text' && (kind === undefined || kind === 'agentMessage')) {
        const delta = typeof params.delta === 'string' ? params.delta : '';
        if (delta) {
          run.gotDelta = true;
          run.onEvent({ sessionId: run.shSessionId, runId: run.runId, kind: 'delta', text: delta });
        }
      }
    } else if (method === 'turn/completed' && run) {
      this.activeRuns.delete(run.nativeSessionId);
      const terminal = typeof params.terminal === 'string' ? params.terminal : 'completed';
      if (terminal === 'failed' || terminal === 'error') {
        const errObj = params.error as Record<string, unknown> | undefined;
        run.onEvent({
          sessionId: run.shSessionId,
          runId: run.runId,
          kind: 'error',
          error: typeof errObj?.message === 'string' ? errObj.message : 'Muse turn failed',
        });
      } else {
        run.onEvent({ sessionId: run.shSessionId, runId: run.runId, kind: 'done' });
      }
      run.onComplete();
    }

    this.opts.onNotification?.(method, params);
  }

  async initialize(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = (async () => {
      const name = this.opts.clientName ?? 'super_harness';
      const result = await this.request(
        'initialize',
        {
          clientInfo: {
            name: isValidMspClientName(name) ? name : 'super_harness',
            title: 'Superharness',
            version: this.opts.clientVersion ?? '0.1.0',
          },
          capabilities: { experimentalApi: false, userInputDialogs: false },
        },
        15_000
      );
      const schema = result.schema as Record<string, unknown> | undefined;
      if (schema && schema.version !== undefined && schema.version !== 1) {
        throw new Error(`Unsupported Muse MSP schema version: ${String(schema.version)}`);
      }
      this.write({ jsonrpc: '2.0', method: 'initialized', params: {} });
    })();
    return this.initPromise;
  }

  async request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = 30_000
  ): Promise<Record<string, unknown>> {
    if (this.closed) throw new Error('Muse MSP host connection closed');
    const id = this.nextId++;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Muse MSP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  private async ensureResumed(nativeSessionId: string): Promise<void> {
    if (this.resumedSessions.has(nativeSessionId)) return;
    await this.request('session/resume', {
      commandId: uuidv7(),
      sessionId: nativeSessionId,
      excludeItems: true,
    });
    this.resumedSessions.add(nativeSessionId);
    // Superharness has no approval UI on this lane yet; match the other
    // dispatched harnesses' posture instead of blocking on a prompt nobody
    // can answer. Best-effort: older hosts may reject, turn still proceeds.
    try {
      await this.request(
        'session/setApprovalMode',
        { commandId: uuidv7(), sessionId: nativeSessionId, mode: 'allowAll' },
        5_000
      );
    } catch {
      // keep host default
    }
  }

  async readSession(
    nativeSessionId: string,
    excludeItems: boolean
  ): Promise<Record<string, unknown>> {
    await this.initialize();
    return this.request('session/read', { sessionId: nativeSessionId, excludeItems }, 30_000);
  }

  async startSession(opts: {
    cwd: string;
    model?: string;
  }): Promise<string> {
    await this.initialize();
    const params: Record<string, unknown> = {
      commandId: uuidv7(),
      workspaceRoot: opts.cwd,
      approvalMode: 'allowAll',
    };
    if (opts.model?.trim()) params.modelId = opts.model.trim();
    const res = await this.request('session/start', params, 30_000);
    const session = res.session as Record<string, unknown> | undefined;
    const sessionId =
      typeof session?.sessionId === 'string'
        ? session.sessionId
        : typeof res.sessionId === 'string'
          ? res.sessionId
          : '';
    if (!sessionId) throw new Error('Muse MSP session/start did not return a session id');
    this.resumedSessions.add(sessionId);
    return sessionId;
  }

  hasActiveTurn(nativeSessionId: string): boolean {
    return this.activeRuns.has(nativeSessionId);
  }

  async sendTurn(opts: {
    shSessionId: string;
    nativeSessionId: string;
    prompt: string;
    attachments?: ImageAttachment[];
    reasoningEffort?: string;
    runId: string;
    onEvent: (ev: StreamEvent) => void;
    onComplete: () => void;
  }): Promise<{ turnId?: string }> {
    await this.initialize();
    await this.ensureResumed(opts.nativeSessionId);

    const input = buildMuseTurnInputs(opts.prompt, opts.attachments);
    if (input.length === 0) throw new Error('Empty prompt');

    const run: ActiveMspRun = {
      shSessionId: opts.shSessionId,
      nativeSessionId: opts.nativeSessionId,
      runId: opts.runId,
      gotDelta: false,
      onEvent: opts.onEvent,
      onComplete: opts.onComplete,
    };
    this.activeRuns.set(opts.nativeSessionId, run);
    opts.onEvent({ sessionId: opts.shSessionId, runId: opts.runId, kind: 'start' });

    const params: Record<string, unknown> = {
      commandId: uuidv7(),
      sessionId: opts.nativeSessionId,
      input,
      ifBusy: 'queue',
    };
    const effort = opts.reasoningEffort?.trim().toLowerCase();
    if (effort) params.reasoningEffort = effort;

    try {
      const res = await this.request('turn/start', params, 25_000);
      const turnId = typeof res.turnId === 'string' ? res.turnId : undefined;
      if (turnId) run.turnId = turnId;
      return { turnId };
    } catch (err) {
      this.activeRuns.delete(opts.nativeSessionId);
      this.resumedSessions.delete(opts.nativeSessionId);
      throw err;
    }
  }

  async steerTurn(
    nativeSessionId: string,
    prompt: string,
    attachments?: ImageAttachment[]
  ): Promise<boolean> {
    try {
      await this.initialize();
      let expectedTurnId = this.activeRuns.get(nativeSessionId)?.turnId;
      if (!expectedTurnId) {
        const read = await this.readSession(nativeSessionId, true);
        const session = read.session as Record<string, unknown> | undefined;
        if (typeof session?.activeTurnId === 'string' && session.activeTurnId) {
          expectedTurnId = session.activeTurnId;
        }
      }
      if (!expectedTurnId) return false;
      await this.request(
        'turn/steer',
        {
          commandId: uuidv7(),
          sessionId: nativeSessionId,
          expectedTurnId,
          input: buildMuseTurnInputs(prompt, attachments),
        },
        10_000
      );
      return true;
    } catch {
      return false;
    }
  }

  /** Interrupts the running turn; idle sessions answer missing-run = no-op. */
  async interruptSession(nativeSessionId: string): Promise<boolean> {
    try {
      await this.initialize();
      const run = this.activeRuns.get(nativeSessionId);
      await this.request(
        'turn/interrupt',
        {
          commandId: uuidv7(),
          sessionId: nativeSessionId,
          ...(run?.turnId ? { turnId: run.turnId } : {}),
        },
        10_000
      );
      return true;
    } catch {
      return false;
    }
  }

  async setModel(nativeSessionId: string, modelId: string): Promise<void> {
    await this.initialize();
    await this.request('session/setModel', {
      commandId: uuidv7(),
      sessionId: nativeSessionId,
      model: { modelId },
    });
  }
}

export interface MuseMspClientOptions {
  resolveBin: () => Promise<string | null>;
  /** 'serve' = pooled durable host; 'attach' = bridge to the holding host. */
  lane: 'serve' | 'attach';
  /** Required for the attach lane. */
  attachSessionId?: string;
  /** Extra `muse serve` flags (tests/probes only, e.g. --provider echo). */
  extraServeArgs?: string[];
  env?: NodeJS.ProcessEnv;
  onNotification?: (method: string, params: Record<string, unknown>) => void;
}

/**
 * Process-managing MSP client. The pooled lane spawns one durable
 * `muse serve --disable-sandbox --trust-workspace --enable-attach` host
 * (never `--no-session-log`: ephemeral hosts withhold session/read) and
 * restarts it on exit. The attach lane spawns `muse attach --stdio <id>`
 * for sessions whose holding host exposes an attach endpoint; a
 * terminal-held session makes that process exit 4, which surfaces as a
 * connection failure the adapter turns into an honest refusal.
 */
export class MuseMspClient {
  private child: ChildProcess | null = null;
  private connection: MuseMspConnection | null = null;
  private connectPromise: Promise<MuseMspConnection> | null = null;
  private stderrTail = '';

  constructor(private readonly opts: MuseMspClientOptions) {}

  buildServeArgs(): string[] {
    const posture = ['--disable-sandbox', '--trust-workspace'];
    if (this.opts.lane === 'attach') {
      return [
        'attach',
        '--stdio',
        this.opts.attachSessionId ?? '',
        '--',
        ...posture,
        ...(this.opts.extraServeArgs ?? []),
      ];
    }
    return ['serve', ...posture, '--enable-attach', ...(this.opts.extraServeArgs ?? [])];
  }

  lastStderr(): string {
    return this.stderrTail.trim();
  }

  async ensureConnected(): Promise<MuseMspConnection> {
    if (this.connection) return this.connection;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = (async () => {
      const bin = await this.opts.resolveBin();
      if (!bin) throw new Error('muse CLI not found');
      if (this.opts.lane === 'attach' && !this.opts.attachSessionId) {
        throw new Error('attach lane requires a session id');
      }
      const child = spawn(bin, this.buildServeArgs(), {
        env: this.opts.env ?? process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.child = child;
      this.stderrTail = '';
      child.stderr?.on('data', (chunk: Buffer) => {
        this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-4000);
      });
      const conn = new MuseMspConnection({
        input: child.stdin!,
        output: child.stdout!,
        onNotification: this.opts.onNotification,
        onClose: () => {
          if (this.connection === conn) {
            this.connection = null;
            this.child = null;
          }
        },
      });
      child.on('exit', () => conn.close());
      child.on('error', () => conn.close());
      try {
        await conn.initialize();
      } catch (err) {
        conn.close();
        try {
          child.kill('SIGTERM');
        } catch {
          // already exited (e.g. attach exit 4)
        }
        const detail = this.stderrTail.trim();
        throw new Error(
          detail
            ? `Muse MSP host failed to start: ${detail.split('\n').pop()}`
            : err instanceof Error
              ? err.message
              : 'Muse MSP host failed to start'
        );
      }
      this.connection = conn;
      return conn;
    })();
    try {
      return await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  async sendTurn(
    opts: Parameters<MuseMspConnection['sendTurn']>[0]
  ): Promise<{ turnId?: string }> {
    const conn = await this.ensureConnected();
    return conn.sendTurn(opts);
  }

  async startSession(opts: { cwd: string; model?: string }): Promise<string> {
    const conn = await this.ensureConnected();
    return conn.startSession(opts);
  }

  async readSession(
    nativeSessionId: string,
    excludeItems: boolean
  ): Promise<Record<string, unknown>> {
    const conn = await this.ensureConnected();
    return conn.readSession(nativeSessionId, excludeItems);
  }

  async steerTurn(
    nativeSessionId: string,
    prompt: string,
    attachments?: ImageAttachment[]
  ): Promise<boolean> {
    try {
      const conn = await this.ensureConnected();
      return conn.steerTurn(nativeSessionId, prompt, attachments);
    } catch {
      return false;
    }
  }

  async interruptSession(nativeSessionId: string): Promise<boolean> {
    try {
      const conn = await this.ensureConnected();
      return conn.interruptSession(nativeSessionId);
    } catch {
      return false;
    }
  }

  hasActiveTurn(nativeSessionId: string): boolean {
    return this.connection?.hasActiveTurn(nativeSessionId) ?? false;
  }

  close(): void {
    this.connection?.close();
    this.connection = null;
    if (this.child) {
      try {
        this.child.stdin?.end();
      } catch {
        // ignore
      }
      const child = this.child;
      const timer = setTimeout(() => {
        try {
          child.kill('SIGTERM');
        } catch {
          // ignore
        }
      }, 1500);
      timer.unref?.();
      this.child = null;
    }
  }
}
