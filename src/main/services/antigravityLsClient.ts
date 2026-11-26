import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import type { ImageAttachment } from '../../shared/types';

/**
 * Native Antigravity hub language-server client — the exact API Antigravity
 * Desktop's own UI uses. Desktop spawns `language_server --subclient_type hub`
 * serving its renderer over loopback HTTPS; the renderer dispatches with
 * Connect+JSON to `exa.language_server_pb.LanguageServerService`
 * (`SendUserCascadeMessage`, `StartCascade`, `StreamAgentStateUpdates`, …)
 * authenticated by the `x-codeium-csrf-token` header. Hub coordinates are
 * published at `~/.gemini/antigravity/daemon/hub_<httpPort>.json`.
 *
 * All shapes were verified empirically against the live hub LS (2.34.0):
 * `StartCascade{cascadeId, source:1}` + `SendUserCascadeMessage{cascadeId,
 * items:[{text}], media?, cascadeConfig:{plannerConfig:{planModel}}}` authors
 * a `CORTEX_STEP_SOURCE_USER_EXPLICIT` user step identical to Desktop typing.
 *
 * CPU discipline (the previous version pegged the main thread): agent-state
 * frames are huge snapshots (hundreds of KB) and arrive continuously, so
 * this client never JSON-parses them and never forwards per-frame work.
 * `AgentStateSignalGate` extracts only status + last step index via regex
 * and emits at most one notification per cascade per second, only when a
 * signal actually changed. Subscriptions are capped (LRU) so prefetches
 * cannot accumulate unbounded streams.
 */

export interface AntigravityHub {
  pid: number;
  httpsPort: number;
  httpPort?: number;
  lsVersion?: string;
  csrfToken: string;
}

export function parseAntigravityHubFile(text: string): AntigravityHub | null {
  try {
    const obj = JSON.parse(text) as Record<string, unknown>;
    const pid = typeof obj.pid === 'number' ? obj.pid : Number(obj.pid);
    const httpsPort = typeof obj.httpsPort === 'number' ? obj.httpsPort : Number(obj.httpsPort);
    const csrfToken = typeof obj.csrfToken === 'string' ? obj.csrfToken : '';
    if (!Number.isFinite(pid) || pid <= 0) return null;
    if (!Number.isFinite(httpsPort) || httpsPort <= 0) return null;
    if (!csrfToken) return null;
    return {
      pid,
      httpsPort,
      httpPort: typeof obj.httpPort === 'number' ? obj.httpPort : undefined,
      lsVersion: typeof obj.lsVersion === 'string' ? obj.lsVersion : undefined,
      csrfToken,
    };
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export const AGY_HUB_DIR = path.join(os.homedir(), '.gemini', 'antigravity', 'daemon');

/** Finds the live hub LS, rejecting stale hub files whose pid is gone. */
export function discoverAntigravityHub(daemonDir: string = AGY_HUB_DIR): AntigravityHub | null {
  try {
    const names = fs
      .readdirSync(daemonDir)
      .filter((n) => n.startsWith('hub_') && n.endsWith('.json'))
      .sort()
      .reverse();
    for (const name of names) {
      try {
        const hub = parseAntigravityHubFile(fs.readFileSync(path.join(daemonDir, name), 'utf8'));
        if (hub && isPidAlive(hub.pid)) return hub;
      } catch {
        // try next candidate
      }
    }
  } catch {
    // no daemon dir
  }
  return null;
}

/** Encodes one Connect streaming envelope (1-byte flags + 4-byte BE length). */
export function encodeConnectEnvelope(obj: unknown, endStream = false): Buffer {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const out = Buffer.alloc(5 + body.length);
  out[0] = endStream ? 0x02 : 0x00;
  out.writeUInt32BE(body.length, 1);
  body.copy(out, 5);
  return out;
}

export interface ConnectEnvelope {
  endStream: boolean;
  body: string;
}

export interface ConnectEnvelopeBytes {
  endStream: boolean;
  bytes: Buffer;
}

/**
 * Incremental decoder for Connect streaming envelopes over chunked HTTPS.
 *
 * Agent-state frames can be many MB and arrive in 16–64 KB socket chunks, so
 * chunks are queued and joined once per complete frame. Re-concatenating the
 * whole buffer on every chunk was quadratic and blocked the main (browser UI)
 * thread for seconds at a time, freezing the window.
 */
export class ConnectEnvelopeDecoder {
  private chunks: Buffer[] = [];
  private total = 0;

  push(chunk: Buffer): ConnectEnvelope[] {
    return this.pushBytes(chunk).map((f) => ({ endStream: f.endStream, body: f.bytes.toString('utf8') }));
  }

  /** Like `push`, but leaves each frame body as raw bytes (no multi-MB string decode). */
  pushBytes(chunk: Buffer): ConnectEnvelopeBytes[] {
    if (chunk.length > 0) {
      this.chunks.push(chunk);
      this.total += chunk.length;
    }
    const frames: ConnectEnvelopeBytes[] = [];
    while (this.total >= 5) {
      const head = this.chunks[0].length >= 5 ? this.chunks[0] : this.join();
      const len = head.readUInt32BE(1);
      if (this.total < 5 + len) break;
      const buf = this.join();
      frames.push({ endStream: (buf[0] & 0x02) !== 0, bytes: buf.subarray(5, 5 + len) });
      const rest = buf.subarray(5 + len);
      this.chunks = rest.length > 0 ? [rest] : [];
      this.total = rest.length;
    }
    return frames;
  }

  /** Collapses the queued chunks into one buffer (no copy when there is only one). */
  private join(): Buffer {
    if (this.chunks.length > 1) this.chunks = [Buffer.concat(this.chunks, this.total)];
    return this.chunks[0];
  }
}

export interface AgentStateSignals {
  status: string | null;
  lastStepIdx: number | null;
}

const STATUS_RE = /"status":"(CASCADE_RUN_STATUS_[A-Z_]+)"/;
const STEP_RE = /"lastStepIdx":\s*(\d+)/;

/**
 * Extracts the two liveness signals from an agent-state frame WITHOUT
 * parsing its (potentially hundreds-of-KB) JSON body.
 */
export function extractAgentStateSignals(body: string): AgentStateSignals {
  const status = STATUS_RE.exec(body)?.[1] ?? null;
  const stepRaw = STEP_RE.exec(body)?.[1];
  return { status, lastStepIdx: stepRaw !== undefined ? Number(stepRaw) : null };
}

const STATUS_PREFIX = Buffer.from('"status":"CASCADE_RUN_STATUS_');
const STEP_PREFIX = Buffer.from('"lastStepIdx":');

const isUpperOrUnderscore = (c: number) => (c >= 0x41 && c <= 0x5a) || c === 0x5f;
const isDigit = (c: number) => c >= 0x30 && c <= 0x39;
const isAsciiSpace = (c: number) => c === 0x20 || (c >= 0x09 && c <= 0x0d);

/**
 * Same result as `extractAgentStateSignals(buf.toString('utf8'))`, found with native
 * byte search so a 60 MB agent-state frame never has to become a JS string. Both
 * markers are pure ASCII, and UTF-8 never encodes other characters with ASCII bytes.
 */
export function extractAgentStateSignalsFromBuffer(buf: Buffer): AgentStateSignals {
  let status: string | null = null;
  for (let at = buf.indexOf(STATUS_PREFIX); at !== -1; at = buf.indexOf(STATUS_PREFIX, at + 1)) {
    let end = at + STATUS_PREFIX.length;
    while (end < buf.length && isUpperOrUnderscore(buf[end])) end++;
    // `[A-Z_]+"`: a non-empty run closed by a quote (a shorter run can never end in `"`).
    if (end > at + STATUS_PREFIX.length && buf[end] === 0x22) {
      status = buf.toString('latin1', at + '"status":"'.length, end);
      break;
    }
  }
  let lastStepIdx: number | null = null;
  for (let at = buf.indexOf(STEP_PREFIX); at !== -1; at = buf.indexOf(STEP_PREFIX, at + 1)) {
    let i = at + STEP_PREFIX.length;
    while (i < buf.length && isAsciiSpace(buf[i])) i++;
    const start = i;
    while (i < buf.length && isDigit(buf[i])) i++;
    if (i > start) {
      lastStepIdx = Number(buf.toString('latin1', start, i));
      break;
    }
  }
  return { status, lastStepIdx };
}

/**
 * Change-only, rate-limited gate for agent-state frames: `offer` returns
 * true at most once per `minIntervalMs` and only when (status, lastStepIdx)
 * changed since the last notification. Changed-but-throttled offers are
 * remembered (`hasPending`) so a trailing timer can re-offer.
 */
export class AgentStateSignalGate {
  private lastNotifiedKey = '';
  private lastNotifiedAt = -Infinity;
  private pendingKey = '';

  constructor(private readonly minIntervalMs = 1000) {}

  offer(body: string, now: number): boolean {
    return this.offerSignals(extractAgentStateSignals(body), now);
  }

  offerSignals({ status, lastStepIdx }: AgentStateSignals, now: number): boolean {
    if (status === null && lastStepIdx === null) return false;
    const key = `${status ?? ''}|${lastStepIdx ?? ''}`;
    if (key === this.lastNotifiedKey) {
      this.pendingKey = '';
      return false;
    }
    if (now - this.lastNotifiedAt >= this.minIntervalMs) {
      this.lastNotifiedKey = key;
      this.lastNotifiedAt = now;
      this.pendingKey = '';
      return true;
    }
    this.pendingKey = key;
    return false;
  }

  hasPending(): boolean {
    return this.pendingKey.length > 0 && this.pendingKey !== this.lastNotifiedKey;
  }
}

/** `CortexTrajectorySource.CASCADE_CLIENT` — the Desktop client's own source. */
export const AGY_TRAJECTORY_SOURCE_CASCADE_CLIENT = 1;

export function buildStartCascadeRequest(cascadeId: string): Record<string, unknown> {
  return { cascadeId, source: AGY_TRAJECTORY_SOURCE_CASCADE_CLIENT };
}

export function buildSendUserCascadeMessageRequest(opts: {
  cascadeId: string;
  text: string;
  attachments?: ImageAttachment[];
  planModel?: string | null;
}): Record<string, unknown> {
  const req: Record<string, unknown> = {
    cascadeId: opts.cascadeId,
    items: opts.text.trim() ? [{ text: opts.text }] : [],
  };
  const media: Array<Record<string, unknown>> = [];
  for (const att of opts.attachments ?? []) {
    if (!att.path) continue;
    media.push({
      mediaId: att.name || path.basename(att.path),
      mimeType: att.mimeType && att.mimeType.startsWith('image/') ? att.mimeType : 'image/png',
      inlineData: fs.readFileSync(att.path).toString('base64'),
    });
  }
  if (media.length > 0) req.media = media;
  if (opts.planModel) {
    req.cascadeConfig = { plannerConfig: { planModel: opts.planModel } };
  }
  return req;
}

/**
 * Maps an `agy models` slug to the LS `planModel` enum using the hub's own
 * `GetAvailableModels` response. Falls back to the first recommended model.
 */
export function pickPlanModelEnum(availableModelsResponse: unknown, slug?: string): string | null {
  const models = (
    availableModelsResponse as { response?: { models?: Record<string, Record<string, unknown>> } }
  )?.response?.models;
  if (!models || typeof models !== 'object') return null;
  if (slug && typeof models[slug]?.model === 'string') return models[slug].model as string;
  const recommended = Object.keys(models)
    .filter((s) => models[s]?.recommended === true && typeof models[s]?.model === 'string')
    .sort();
  return recommended.length > 0 ? (models[recommended[0]].model as string) : null;
}

const LS_SERVICE = 'exa.language_server_pb.LanguageServerService';
const MAX_AGENT_STATE_SUBSCRIPTIONS = 3;

export class AntigravityLsError extends Error {
  constructor(
    message: string,
    readonly code?: string
  ) {
    super(message);
    this.name = 'AntigravityLsError';
  }
}

interface LsSubscription {
  cascadeId: string;
  close: () => void;
}

/**
 * Connect+JSON client for the hub LS (renderer transport:
 * `useBinaryFormat:false`, `x-codeium-csrf-token` header, TLS verification
 * off only for the loopback hub — Desktop's own trust call).
 */
export class AntigravityLsClient {
  private modelsCache: { at: number; response: Record<string, unknown> } | null = null;
  private subscriptions = new Map<string, LsSubscription>();
  private observedStatus = new Map<string, string>();

  constructor(private readonly daemonDir: string = AGY_HUB_DIR) {}

  getHub(): AntigravityHub | null {
    return discoverAntigravityHub(this.daemonDir);
  }

  isHubAvailable(): boolean {
    return this.getHub() !== null;
  }

  private async callUnary(
    method: string,
    payload: Record<string, unknown>,
    timeoutMs = 20_000
  ): Promise<Record<string, unknown>> {
    const hub = this.getHub();
    if (!hub) throw new AntigravityLsError('Antigravity Desktop hub language server is not running');
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          host: '127.0.0.1',
          port: hub.httpsPort,
          path: `/${LS_SERVICE}/${method}`,
          method: 'POST',
          rejectUnauthorized: false,
          headers: {
            'Content-Type': 'application/json',
            'Connect-Protocol-Version': '1',
            'x-codeium-csrf-token': hub.csrfToken,
            'Content-Length': String(body.length),
          },
          timeout: timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let parsed: Record<string, unknown> = {};
            try {
              parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
            } catch {
              reject(new AntigravityLsError(`Antigravity LS ${method} returned invalid JSON`));
              return;
            }
            if (res.statusCode && res.statusCode >= 400) {
              const message =
                typeof parsed.message === 'string' ? parsed.message : `HTTP ${res.statusCode}`;
              reject(
                new AntigravityLsError(
                  `Antigravity LS ${method} failed: ${message.slice(0, 500)}`,
                  typeof parsed.code === 'string' ? parsed.code : undefined
                )
              );
              return;
            }
            resolve(parsed);
          });
        }
      );
      req.on('timeout', () => req.destroy(new Error(`Antigravity LS ${method} timed out`)));
      req.on('error', (err) =>
        reject(err instanceof Error ? err : new AntigravityLsError(String(err)))
      );
      req.end(body);
    });
  }

  async startCascade(cascadeId: string): Promise<void> {
    await this.callUnary('StartCascade', buildStartCascadeRequest(cascadeId));
  }

  async getAvailableModels(): Promise<Record<string, unknown>> {
    if (this.modelsCache && Date.now() - this.modelsCache.at < 60_000) {
      return this.modelsCache.response;
    }
    const response = await this.callUnary('GetAvailableModels', {});
    this.modelsCache = { at: Date.now(), response };
    return response;
  }

  /** Slug -> planModel enum, with the cascade's own last model as fallback. */
  async resolvePlanModel(slug?: string, cascadeId?: string): Promise<string | null> {
    try {
      const models = await this.getAvailableModels();
      const picked = pickPlanModelEnum(models, slug);
      if (picked) return picked;
    } catch {
      // fall through to trajectory reuse
    }
    if (cascadeId) {
      try {
        const traj = await this.callUnary('GetCascadeTrajectory', { cascadeId });
        const trajectory = traj.trajectory as Record<string, unknown> | undefined;
        const metas = Array.isArray(trajectory?.generatorMetadata)
          ? (trajectory.generatorMetadata as Array<Record<string, unknown>>)
          : [];
        for (let i = metas.length - 1; i >= 0; i--) {
          const chatModel = metas[i]?.chatModel as Record<string, unknown> | undefined;
          if (typeof chatModel?.model === 'string' && chatModel.model) return chatModel.model;
        }
      } catch {
        // unresolved
      }
    }
    return null;
  }

  async sendUserMessage(opts: {
    cascadeId: string;
    text: string;
    attachments?: ImageAttachment[];
    modelSlug?: string;
  }): Promise<void> {
    const planModel = await this.resolvePlanModel(opts.modelSlug, opts.cascadeId);
    await this.callUnary(
      'SendUserCascadeMessage',
      buildSendUserCascadeMessageRequest({ ...opts, planModel }),
      30_000
    );
  }

  async cancelInvocation(cascadeId: string): Promise<void> {
    await this.callUnary('CancelCascadeInvocation', { cascadeId }, 10_000);
  }

  /** Last cascade status observed on its agent-state stream (no RPC cost). */
  getObservedStatus(cascadeId: string): string | null {
    return this.observedStatus.get(cascadeId) ?? null;
  }

  /**
   * Subscribes to `StreamAgentStateUpdates` for one conversation. Frames
   * are signal-gated (change-only, ≥1s apart, no JSON.parse of the huge
   * snapshot bodies) before `onUpdate` fires, and concurrent subscriptions
   * are capped with LRU eviction — this stream can never flood LiveSync.
   */
  subscribeAgentState(cascadeId: string, onUpdate: () => void): void {
    const existing = this.subscriptions.get(cascadeId);
    if (existing) {
      this.subscriptions.delete(cascadeId);
      this.subscriptions.set(cascadeId, existing);
      return;
    }
    const hub = this.getHub();
    if (!hub) return;
    while (this.subscriptions.size >= MAX_AGENT_STATE_SUBSCRIPTIONS) {
      const oldest = this.subscriptions.keys().next().value as string;
      this.subscriptions.get(oldest)?.close();
      this.subscriptions.delete(oldest);
    }

    const gate = new AgentStateSignalGate(1000);
    let trailingTimer: ReturnType<typeof setTimeout> | null = null;
    let lastSignals: AgentStateSignals = { status: null, lastStepIdx: null };
    const offerSignals = (signals: AgentStateSignals) => {
      lastSignals = signals;
      if (signals.status) this.observedStatus.set(cascadeId, signals.status);
      if (gate.offerSignals(signals, Date.now())) {
        onUpdate();
      } else if (gate.hasPending() && !trailingTimer) {
        trailingTimer = setTimeout(() => {
          trailingTimer = null;
          if (gate.offerSignals(lastSignals, Date.now())) onUpdate();
        }, 1050);
        trailingTimer.unref?.();
      }
    };

    const decoder = new ConnectEnvelopeDecoder();
    const req = https.request(
      {
        host: '127.0.0.1',
        port: hub.httpsPort,
        path: `/${LS_SERVICE}/StreamAgentStateUpdates`,
        method: 'POST',
        rejectUnauthorized: false,
        headers: {
          'Content-Type': 'application/connect+json',
          'Connect-Protocol-Version': '1',
          'x-codeium-csrf-token': hub.csrfToken,
        },
      },
      (res) => {
        res.on('data', (chunk: Buffer) => {
          for (const frame of decoder.pushBytes(chunk)) {
            if (!frame.endStream) offerSignals(extractAgentStateSignalsFromBuffer(frame.bytes));
          }
        });
        res.on('end', () => this.subscriptions.delete(cascadeId));
        res.on('error', () => this.subscriptions.delete(cascadeId));
      }
    );
    req.on('error', () => this.subscriptions.delete(cascadeId));
    req.write(encodeConnectEnvelope({ conversationId: cascadeId }));
    req.end();
    this.subscriptions.set(cascadeId, {
      cascadeId,
      close: () => {
        if (trailingTimer) clearTimeout(trailingTimer);
        try {
          req.destroy();
        } catch {
          // already gone
        }
      },
    });
  }

  closeAll(): void {
    for (const sub of this.subscriptions.values()) sub.close();
    this.subscriptions.clear();
  }
}
