import { execFile } from 'node:child_process';
import { ORCHESTRATOR_MEMORY_PATH, readOrchestratorMemory, writeOrchestratorMemory } from './orchestratorMemory';
import { DictationError, audioExtensionFor, checkDictationServer, transcribeAudio } from './dictation';
import type { AuthResult, PairingService } from './pairing';
import type net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import zlib from 'node:zlib';

const execFileAsync = promisify(execFile);
const WEBP_CACHE_DIR = path.join(os.tmpdir(), 'sh-media-webp-cache');
const TRANSCODABLE_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.bmp', '.tif', '.tiff']);

const COMPACT_CMD_MAX = 320;
const COMPACT_OUT_MAX = 400;

/**
 * Compacts collapsed historical command/tool blocks for mobile delivery (`?compact=1` and SSE pushes)
 * so 60-message sessions transfer ~3x less data over Tailscale cellular while keeping prose, diffs,
 * thinking, and actively running commands untouched. Opt-in on GET /api/transcript so MCP tools
 * always receive full untruncated output.
 */
function compactTranscriptForMobile<T>(tr: T): T {
  if (!tr || typeof tr !== 'object') return tr;
  const obj = tr as { messages?: unknown[] };
  if (!Array.isArray(obj.messages)) return tr;
  let changed = false;
  const messages = obj.messages.map((rawMsg) => {
    if (!rawMsg || typeof rawMsg !== 'object') return rawMsg;
    const msg = rawMsg as { blocks?: unknown[] };
    if (!Array.isArray(msg.blocks)) return rawMsg;
    let msgChanged = false;
    const blocks = msg.blocks.map((rawBlock) => {
      if (!rawBlock || typeof rawBlock !== 'object') return rawBlock;
      const b = rawBlock as Record<string, unknown>;
      if (b.status === 'running') return rawBlock;
      if (b.type === 'command') {
        const cmd = typeof b.command === 'string' ? b.command : '';
        const out = typeof b.output === 'string' ? b.output : '';
        const needCmd = cmd.length > COMPACT_CMD_MAX;
        const needOut = out.length > COMPACT_OUT_MAX;
        if (!needCmd && !needOut) return rawBlock;
        msgChanged = true;
        return {
          ...b,
          command: needCmd ? `${cmd.slice(0, COMPACT_CMD_MAX)}…` : cmd,
          output: needOut ? `…\n${out.slice(-COMPACT_OUT_MAX)}` : out,
          ...(needOut ? { outputTruncated: true, outputLength: out.length } : {}),
        };
      }
      if (b.type === 'tool_call') {
        const args = typeof b.args === 'string' ? b.args : '';
        const out = typeof b.output === 'string' ? b.output : '';
        const needArgs = args.length > COMPACT_CMD_MAX;
        const needOut = out.length > COMPACT_OUT_MAX;
        if (!needArgs && !needOut) return rawBlock;
        msgChanged = true;
        return {
          ...b,
          args: needArgs ? `${args.slice(0, COMPACT_CMD_MAX)}…` : args,
          output: needOut ? `…\n${out.slice(-COMPACT_OUT_MAX)}` : out,
          ...(needOut ? { outputTruncated: true, outputLength: out.length } : {}),
        };
      }
      return rawBlock;
    });
    if (!msgChanged) return rawMsg;
    changed = true;
    return { ...msg, blocks };
  });
  return changed ? ({ ...obj, messages } as T) : tr;
}
import type {
  FilePreviewData,
  HarnessCatalog,
  HarnessGroup,
  HarnessUpdateJob,
  ImageAttachment,
  MobileApiSettings,
  OrganizeAction,
  SendMessageResult,
  StartSessionRequest,
  SuperHarnessSettings,
  UsageSnapshot,
} from '../../shared/types';
import type { HarnessRegistry } from '../adapters/registry';
import type { ConfigStore } from '../store/configStore';
import type { HarnessDispatcher } from './dispatcher';

export const MOBILE_PROTOCOL_VERSION = 2;

export interface ControlServerHooks {
  getUsage?: (force: boolean) => Promise<UsageSnapshot>;
  getCatalog?: (force: boolean) => Promise<HarnessCatalog>;
  sendMessage?: (
    sessionId: string,
    prompt: string,
    attachments?: ImageAttachment[],
    opts?: { force?: boolean }
  ) => Promise<SendMessageResult>;
  onMessageSent?: (sessionId: string) => void;
  abortRun?: (sessionId: string) => Promise<{ ok: boolean }>;
  saveAttachment?: (dataUrl: string, filename?: string) => Promise<ImageAttachment>;
  saveRawAttachment?: (
    buffer: Buffer,
    mimeType: string,
    filename?: string
  ) => Promise<ImageAttachment & { sizeBytes?: number; kind?: 'image' | 'video' | 'file' }>;
  queueMessage?: (
    sessionId: string,
    prompt: string,
    attachments?: ImageAttachment[]
  ) => Promise<SendMessageResult>;
  registerPushDevice?: (opts: {
    rid?: string;
    relayUrl?: string;
    enabled?: boolean;
    /** The Bearer token the phone authenticated with; the push relay key is derived from it. */
    authToken?: string;
    /** Set when that token belongs to a paired device, so revoking it drops the push key. */
    pairedDeviceId?: string;
  }) => unknown;
  /** Runs a harness's own updater (progress arrives as SSE `harness_update`). */
  startHarnessUpdate?: (
    harness: HarnessGroup
  ) => { ok: true; job: HarnessUpdateJob } | { ok: false; error: string };
  cancelHarnessUpdate?: (harness: HarnessGroup) => boolean;
  getHarnessUpdateJobs?: () => HarnessUpdateJob[];
  /** Phone pairing (/api/pair, per-device tokens). Without it only the legacy token works. */
  pairing?: PairingService;
  sendTestPush?: (opts?: { title?: string; body?: string }) => Promise<unknown>;
  readFilePreview?: (
    filePath: string,
    startLine?: number,
    endLine?: number
  ) => Promise<FilePreviewData>;
  watchSession?: (paneId: string, sessionId: string | null, limit?: number) => Promise<void>;
  getActiveWorkingSessionIds?: () => string[];
  restartApp?: (opts?: { build?: boolean }) => Promise<{ ok: boolean; error?: string }>;
  refreshSummaries?: (opts: { force?: boolean; sessionIds?: string[] }) => Promise<unknown>;
  getSummaries?: () => Record<string, { text: string; updatedAt: number; at: number }>;
}

interface BufferedEvent {
  seq: number;
  event: string;
  frame: string;
  /** Set for per-session events (transcripts) so they only reach clients watching that session. */
  sessionId?: string;
}

const SESSION_SCOPED_EVENTS = new Set(['transcript', 'transcript_updated']);

/**
 * The state sent to phones and MCP clients: settings minus secrets (the legacy mobile token,
 * the dictation API key). The desktop renderer gets the full state over IPC instead.
 */
export function redactStateForClients<T extends { settings?: SuperHarnessSettings }>(state: T): T {
  if (!state || typeof state !== 'object' || !state.settings) return state;
  const settings = { ...state.settings };
  if (settings.mobileApi) {
    const { token: _token, pairedDevices, ...mobileRest } = settings.mobileApi;
    settings.mobileApi = {
      ...mobileRest,
      ...(pairedDevices
        ? { pairedDevices: pairedDevices.map(({ tokenHash: _hash, ...d }) => d) }
        : {}),
    } as typeof settings.mobileApi;
  }
  if (settings.dictation) {
    const { apiKey, ...dictRest } = settings.dictation;
    settings.dictation = { ...dictRest, ...(apiKey ? { hasApiKey: true } : {}) } as typeof settings.dictation;
  }
  return { ...state, settings };
}

/** Settings a phone may not change through POST /api/settings. */
const HOST_ONLY_SETTING_KEYS = ['mobileApi', 'dictation'] as const;

const MEDIA_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
};

/**
 * Token-authenticated HTTP + SSE Control Server.
 *
 * Runs:
 * 1. A loopback-only ephemeral-port server (`127.0.0.1`) with a per-launch token
 *    for the bundled `super-harness-mcp` server.
 * 2. An optional Tailscale/LAN mobile companion server (default `0.0.0.0:47890`)
 *    authenticated with a persistent Bearer token stored in SuperHarnessSettings.
 *
 * Implements Sync Protocol v1: monotonic SSE sequence IDs with Last-Event-ID
 * replay buffer, resync_required signaling on gap, per-client `/api/watch`
 * liveSync bindings, and authenticated `/api/media` streaming.
 */

/** Media files modified more recently than this are treated as still being written. */
const MEDIA_SETTLE_MS = 2000;
export class ControlServer {
  private server: http.Server | null = null;
  private mobileServer: http.Server | null = null;
  private mobileConfigKey = '';
  private sseClients = new Set<http.ServerResponse>();
  private sseGzipByRes = new Map<http.ServerResponse, zlib.Gzip>();
  private sseClientIdByRes = new Map<http.ServerResponse, string>();
  private watchedSessionByClient = new Map<string, string | null>();
  private webpInFlight = new Map<string, Promise<string | null>>();
  /** Open sockets per paired device, so revoking a device cuts its SSE stream and keep-alives. */
  private socketsByDevice = new Map<string, Set<net.Socket>>();
  private sseKeepaliveTimer: NodeJS.Timeout | null = null;
  private eventSeq = 0;
  private eventBuffer: BufferedEvent[] = [];
  private readonly maxBufferedEvents = 200;
  private readonly startedAt = Date.now();
  public port = 0;
  public mobilePort = 0;
  public readonly token = crypto.randomBytes(24).toString('hex');

  constructor(
    private readonly store: ConfigStore,
    private readonly registry: HarnessRegistry,
    private readonly dispatcher: HarnessDispatcher,
    private readonly triggerRefresh: () => Promise<void>,
    private readonly hooks: ControlServerHooks = {}
  ) {}

  /** Mobile clients only receive session-scoped transcripts for the session they explicitly watch. */
  private shouldDeliver(res: http.ServerResponse, item: { event: string; sessionId?: string }): boolean {
    if (!item.sessionId || !SESSION_SCOPED_EVENTS.has(item.event)) return true;
    const clientId = this.sseClientIdByRes.get(res);
    if (!clientId) return false;
    return this.watchedSessionByClient.get(clientId) === item.sessionId;
  }

  private hasWatcherForSession(sessionId: string): boolean {
    for (const watched of this.watchedSessionByClient.values()) {
      if (watched === sessionId) return true;
    }
    return false;
  }

  private writeSseFrame(res: http.ServerResponse, frame: string): void {
    const gz = this.sseGzipByRes.get(res);
    if (gz) {
      gz.write(frame);
      gz.flush(zlib.constants.Z_SYNC_FLUSH);
    } else {
      res.write(frame);
    }
  }

  private removeSseClient(res: http.ServerResponse): void {
    this.sseClients.delete(res);
    this.sseClientIdByRes.delete(res);
    const gz = this.sseGzipByRes.get(res);
    if (gz) {
      this.sseGzipByRes.delete(res);
      try {
        gz.end();
      } catch {
        // ignore
      }
    }
  }

  /**
   * Compresses raster images (PNG/JPEG/etc.) into cached lossy WebP for fast mobile delivery.
   * Returns cached WebP file path, or null to fall back to the original file.
   */
  private async transcodeToCachedWebp(
    filePath: string,
    stat: fs.Stats,
    maxWidth: number,
    quality: number
  ): Promise<string | null> {
    const key = crypto
      .createHash('sha256')
      .update(`${filePath}|${stat.mtimeMs}|${stat.size}|w${maxWidth}|q${quality}`)
      .digest('hex');
    const cachePath = path.join(WEBP_CACHE_DIR, `${key}.webp`);
    if (fs.existsSync(cachePath)) {
      return cachePath;
    }
    const existing = this.webpInFlight.get(key);
    if (existing) return existing;

    const job = (async (): Promise<string | null> => {
      try {
        fs.mkdirSync(WEBP_CACHE_DIR, { recursive: true });
        const tmpPath = `${cachePath}.${process.pid}.${Date.now()}.tmp.webp`;
        await execFileAsync(
          'magick',
          [
            filePath,
            '-auto-orient',
            '-strip',
            '-resize',
            `${maxWidth}x${maxWidth}>`,
            '-quality',
            String(quality),
            `webp:${tmpPath}`,
          ],
          { timeout: 12_000 }
        );
        fs.renameSync(tmpPath, cachePath);
        return cachePath;
      } catch {
        return null;
      } finally {
        this.webpInFlight.delete(key);
      }
    })();

    this.webpInFlight.set(key, job);
    return job;
  }

  broadcastEvent(event: string, data: unknown): void {
    const rawSessionId =
      SESSION_SCOPED_EVENTS.has(event) && data && typeof data === 'object'
        ? (data as { sessionId?: unknown }).sessionId
        : undefined;
    const sessionId = typeof rawSessionId === 'string' ? rawSessionId : undefined;

    // Never serialize, buffer, or broadcast massive desktop transcripts if no mobile client watches them.
    if (sessionId && SESSION_SCOPED_EVENTS.has(event) && !this.hasWatcherForSession(sessionId)) {
      return;
    }

    // Cap mobile SSE transcript payloads to the tail 20 messages and compact collapsed command/tool output.
    let payload: unknown = data;
    if (event === 'state' && data && typeof data === 'object') {
      payload = redactStateForClients(data as { settings?: SuperHarnessSettings });
    }
    if (event === 'transcript' && data && typeof data === 'object') {
      const tr = data as { messages?: unknown[]; hasMore?: boolean };
      const capped =
        Array.isArray(tr.messages) && tr.messages.length > 20
          ? { ...tr, messages: tr.messages.slice(-20), hasMore: true }
          : tr;
      payload = compactTranscriptForMobile(capped);
    }

    const seq = ++this.eventSeq;
    const frame = `id: ${seq}\nevent: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    const item: BufferedEvent = {
      seq,
      event,
      frame,
      sessionId,
    };
    this.eventBuffer.push(item);
    if (this.eventBuffer.length > this.maxBufferedEvents) {
      this.eventBuffer.splice(0, this.eventBuffer.length - this.maxBufferedEvents);
    }
    if (this.sseClients.size === 0) return;
    for (const client of this.sseClients) {
      if (!this.shouldDeliver(client, item)) continue;
      try {
        this.writeSseFrame(client, frame);
      } catch {
        this.removeSseClient(client);
      }
    }
  }

  private ensureKeepalive(): void {
    if (this.sseKeepaliveTimer) return;
    this.sseKeepaliveTimer = setInterval(() => {
      if (this.sseClients.size === 0) return;
      for (const client of this.sseClients) {
        try {
          this.writeSseFrame(client, ': ping\n\n');
        } catch {
          this.removeSseClient(client);
        }
      }
    }, 25_000);
    this.sseKeepaliveTimer.unref?.();
  }

  /** Closes every open connection of a paired device (after it was revoked). */
  dropDeviceConnections(deviceId: string): void {
    const sockets = this.socketsByDevice.get(deviceId);
    if (!sockets) return;
    this.socketsByDevice.delete(deviceId);
    for (const sock of sockets) sock.destroy();
  }

  private trackDeviceSocket(deviceId: string, sock: net.Socket): void {
    let set = this.socketsByDevice.get(deviceId);
    if (!set) {
      set = new Set();
      this.socketsByDevice.set(deviceId, set);
    }
    if (set.has(sock)) return;
    set.add(sock);
    sock.once('close', () => {
      set!.delete(sock);
      if (set!.size === 0 && this.socketsByDevice.get(deviceId) === set) this.socketsByDevice.delete(deviceId);
    });
  }

  private createRequestHandler(
    authenticate: (bearer: string) => AuthResult | null,
    opts: { mobile: boolean } = { mobile: false }
  ): http.RequestListener {
    return async (req, res) => {
      const acceptsGzip = String(req.headers['accept-encoding'] || '').includes('gzip');
      const sendJson = (payload: unknown, statusCode = 200): void => {
        const buf = Buffer.from(JSON.stringify(payload), 'utf8');
        // Conditional GETs: on reconnect/foreground the phone re-requests bootstrap and the
        // open transcript; when nothing changed it gets an empty 304 instead of the payload
        // again (iOS URLCache revalidates with If-None-Match and serves its cached body).
        if (req.method === 'GET' && statusCode === 200) {
          const etag = `"${crypto.createHash('sha1').update(buf).digest('base64url')}"`;
          res.setHeader('ETag', etag);
          res.setHeader('Cache-Control', 'no-cache');
          if (req.headers['if-none-match'] === etag) {
            res.statusCode = 304;
            res.end();
            return;
          }
        }
        res.statusCode = statusCode;
        res.setHeader('Content-Type', 'application/json');
        if (acceptsGzip && buf.length > 1024) {
          // Compress on libuv's thread pool: this process's main thread is also the
          // desktop window's UI thread, so a synchronous gzip of a large transcript stalls it.
          zlib.gzip(buf, { level: 6 }, (err, gz) => {
            if (res.writableEnded) return;
            if (err) {
              res.setHeader('Content-Length', String(buf.length));
              res.end(buf);
              return;
            }
            res.setHeader('Content-Encoding', 'gzip');
            res.setHeader('Vary', 'Accept-Encoding');
            res.setHeader('Content-Length', String(gz.length));
            res.end(gz);
          });
        } else {
          res.setHeader('Content-Length', String(buf.length));
          res.end(buf);
        }
      };

      const url = new URL(req.url || '/', 'http://127.0.0.1');

      // Pairing routes are the only unauthenticated ones, and only on the phone listener.
      const pairing = this.hooks.pairing;
      if (opts.mobile && pairing && url.pathname === '/api/pair/info' && req.method === 'GET') {
        sendJson({ ...pairing.info(), protocolVersion: MOBILE_PROTOCOL_VERSION });
        return;
      }
      if (opts.mobile && pairing && url.pathname === '/api/pair' && req.method === 'POST') {
        let body: Record<string, unknown> = {};
        try {
          const chunks: Buffer[] = [];
          let total = 0;
          for await (const c of req) {
            total += (c as Buffer).length;
            if (total > 4096) throw new Error('too large');
            chunks.push(c as Buffer);
          }
          const raw = Buffer.concat(chunks).toString('utf8').trim();
          body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        } catch {
          sendJson({ ok: false, error: 'Invalid request body' }, 400);
          return;
        }
        const result = pairing.attempt(body, req.socket.remoteAddress || 'unknown');
        console.log(`[ControlServer] /api/pair from ${req.socket.remoteAddress} → ${result.status}`);
        sendJson(result.body, result.status);
        return;
      }

      const authHeader = String(req.headers.authorization || '');
      const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
      const authResult = bearer ? authenticate(bearer) : null;
      if (!authResult) {
        sendJson({ error: 'Unauthorized' }, 401);
        return;
      }
      if (authResult.kind === 'device') this.trackDeviceSocket(authResult.deviceId, req.socket);

      // A paired phone unpairing itself: same as Revoke on the desktop. The legacy token has
      // nothing to unpair, so it gets ok and no change.
      if (opts.mobile && req.method === 'POST' && url.pathname === '/api/unpair') {
        if (authResult.kind === 'device' && pairing) {
          // Reply first: revoking closes this very connection.
          const deviceId = authResult.deviceId;
          res.once('finish', () => pairing.revoke(deviceId));
          sendJson({ ok: true });
        } else {
          sendJson({ ok: true });
        }
        return;
      }
      const readRawBody = async (maxBytes = 55 * 1024 * 1024): Promise<Buffer> => {
        const chunks: Buffer[] = [];
        let total = 0;
        for await (const c of req) {
          const buf = c as Buffer;
          total += buf.length;
          if (total > maxBytes) {
            throw new Error('Request body too large');
          }
          chunks.push(buf);
        }
        return Buffer.concat(chunks);
      };
      const readBody = async (): Promise<Record<string, unknown>> => {
        const raw = (await readRawBody()).toString('utf8').trim();
        return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      };

      try {
        if (req.method === 'GET' && url.pathname === '/api/health') {
          sendJson({
            ok: true,
            protocolVersion: MOBILE_PROTOCOL_VERSION,
            seq: this.eventSeq,
            uptimeMs: Date.now() - this.startedAt,
          });
          return;
        }

        if (req.method === 'GET' && url.pathname === '/api/dictate/status') {
          sendJson(await checkDictationServer(this.store.getState().settings.dictation, 3000));
          return;
        }

        if (req.method === 'POST' && url.pathname === '/api/dictate') {
          const t0 = Date.now();
          const audioBuf = await readRawBody();
          const readMs = Date.now() - t0;
          const contentType = String(req.headers['content-type'] || 'audio/wav');
          try {
            const result = await transcribeAudio(this.store.getState().settings.dictation, audioBuf, contentType, {
              language: url.searchParams.get('language') || undefined,
              prompt: url.searchParams.get('prompt') || undefined,
            });
            console.log(
              `[ControlServer] /api/dictate ${audioExtensionFor(contentType)} ${audioBuf.length}B read=${readMs}ms upstream=${result.timing.upstreamMs}ms`
            );
            // `timing` lets clients separate transcription time from network/proxy overhead
            // (`yapyapMs` is the older name for `upstreamMs`, kept for existing phone builds).
            sendJson({
              ok: true,
              text: result.text,
              timing: { readMs, upstreamMs: result.timing.upstreamMs, yapyapMs: result.timing.upstreamMs },
            });
          } catch (err) {
            const status = err instanceof DictationError ? err.statusCode : 502;
            sendJson({ ok: false, error: err instanceof Error ? err.message : String(err) }, status);
          }
          return;
        }

        if (req.method === 'GET' && url.pathname === '/api/events') {
          const clientId = (url.searchParams.get('clientId') || '').trim();
          const lastEventRaw =
            (req.headers['last-event-id'] as string | undefined) ||
            url.searchParams.get('lastEventId') ||
            '';
          const lastSeq = lastEventRaw ? Number(lastEventRaw) : 0;

          req.socket?.setNoDelay?.(true);
          const sseHeaders: Record<string, string> = {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          };
          if (acceptsGzip) {
            sseHeaders['Content-Encoding'] = 'gzip';
            sseHeaders['Vary'] = 'Accept-Encoding';
          }
          res.writeHead(200, sseHeaders);
          if (acceptsGzip) {
            const gz = zlib.createGzip({ level: 5 });
            gz.on('error', () => this.removeSseClient(res));
            gz.pipe(res);
            this.sseGzipByRes.set(res, gz);
          }
          let initialBurst = `id: ${this.eventSeq}\nevent: connected\ndata: ${JSON.stringify({
            ok: true,
            protocolVersion: MOBILE_PROTOCOL_VERSION,
            seq: this.eventSeq,
          })}\n\n`;

          if (Number.isFinite(lastSeq) && lastSeq > 0) {
            if (lastSeq > this.eventSeq) {
              initialBurst += `id: ${this.eventSeq}\nevent: resync_required\ndata: ${JSON.stringify({
                reason: 'host_restarted',
                lastSeq,
                currentSeq: this.eventSeq,
              })}\n\n`;
            } else if (lastSeq < this.eventSeq) {
              const oldestSeq = this.eventBuffer[0]?.seq ?? this.eventSeq + 1;
              if (lastSeq + 1 < oldestSeq) {
                initialBurst += `id: ${this.eventSeq}\nevent: resync_required\ndata: ${JSON.stringify({
                  reason: 'buffer_gap',
                  lastSeq,
                  currentSeq: this.eventSeq,
                })}\n\n`;
              } else {
                if (clientId) this.sseClientIdByRes.set(res, clientId);
                for (const item of this.eventBuffer) {
                  if (item.seq > lastSeq && this.shouldDeliver(res, item)) {
                    initialBurst += item.frame;
                  }
                }
              }
            }
          }
          this.writeSseFrame(res, initialBurst);

          if (clientId) this.sseClientIdByRes.set(res, clientId);
          this.sseClients.add(res);
          this.ensureKeepalive();
          req.on('close', () => {
            this.removeSseClient(res);
            if (clientId && ![...this.sseClientIdByRes.values()].includes(clientId)) {
              this.watchedSessionByClient.delete(clientId);
            }
            if (clientId && this.hooks.watchSession) {
              void this.hooks.watchSession(`mobile:${clientId}`, null);
            }
          });
          return;
        }

        if (req.method === 'GET' && url.pathname === '/api/bootstrap') {
          // Serve the cached discovery snapshot instantly when available (cold discover() can take
          // ~1s); a background refresh then pushes any changes to the client as sessions_delta.
          const cached =
            typeof this.registry.getCached === 'function'
              ? this.registry.getCached()
              : { harnesses: [], sessions: [] };
          const useCached = cached.sessions.length > 0;
          const { harnesses, sessions: rawSessions } = useCached ? cached : await this.registry.discover();
          if (useCached) void this.triggerRefresh();
          const activeSet = new Set(this.hooks.getActiveWorkingSessionIds?.() ?? []);
          const sessions = rawSessions.map((s) =>
            !s.id.startsWith('master:') && activeSet.has(s.id) ? { ...s, status: 'running' as const } : s
          );
          const activeWorkingSessionIds = Array.from(
            new Set([
              ...activeSet,
              ...sessions
                .filter((s) => !s.id.startsWith('master:') && s.status === 'running')
                .map((s) => s.id),
            ])
          ).sort();
          const [usage, catalog] = await Promise.all([
            this.hooks.getUsage ? this.hooks.getUsage(false).catch(() => undefined) : Promise.resolve(undefined),
            this.hooks.getCatalog ? this.hooks.getCatalog(false).catch(() => undefined) : Promise.resolve(undefined),
          ]);
          sendJson({
            protocolVersion: MOBILE_PROTOCOL_VERSION,
            seq: this.eventSeq,
            harnesses,
            sessions,
            activeWorkingSessionIds,
            state: redactStateForClients(this.store.getState()),
            usage,
            catalog,
          });
          return;
        }

        if (req.method === 'POST' && url.pathname === '/api/watch') {
          if (!this.hooks.watchSession) {
            res.end(JSON.stringify({ ok: true }));
            return;
          }
          const body = await readBody();
          const clientId = String(body.clientId || 'default').replace(/[^a-zA-Z0-9._-]/g, '_');
          const sessionId = body.sessionId ? String(body.sessionId) : null;
          const limit = body.limit ? Number(body.limit) : 80;
          this.watchedSessionByClient.set(clientId, sessionId);
          await this.hooks.watchSession(`mobile:${clientId}`, sessionId, limit);
          res.end(JSON.stringify({ ok: true, paneId: `mobile:${clientId}`, sessionId }));
          return;
        }

        if (req.method === 'GET' && url.pathname === '/api/media') {
          const rawPath = url.searchParams.get('path') || '';
          const expanded = rawPath.startsWith('~/')
            ? path.join(os.homedir(), rawPath.slice(2))
            : rawPath;
          let filePath = expanded;
          if (filePath && !fs.existsSync(filePath)) {
            const base = path.basename(filePath);
            if (base && base !== '.' && base !== '..') {
              const localConfigAtt = path.join(os.homedir(), '.config', 'super-harness', 'attachments', base);
              const localCacheAtt = path.join(os.homedir(), '.cache', 'super-harness', 'attachments', base);
              if (fs.existsSync(localConfigAtt)) filePath = localConfigAtt;
              else if (fs.existsSync(localCacheAtt)) filePath = localCacheAtt;
            }
          }
          const ext = path.extname(filePath).toLowerCase();
          const contentType = MEDIA_MIME_TYPES[ext];
          if (!filePath || !contentType || !fs.existsSync(filePath)) {
            res.statusCode = 404;
            res.end(JSON.stringify({ error: 'Media not found' }));
            return;
          }
          const stat = fs.statSync(filePath);
          if (!stat.isFile()) {
            res.statusCode = 404;
            res.end(JSON.stringify({ error: 'Media not found' }));
            return;
          }

          // A file changed in the last two seconds is probably still being written (e.g. an
          // image generator flushing a PNG). Ask the client to retry instead of handing it a
          // truncated body that it might cache.
          if (Date.now() - stat.mtimeMs < MEDIA_SETTLE_MS) {
            res.writeHead(503, { 'Retry-After': '2', 'Cache-Control': 'no-store', 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Media is still being written; retry shortly' }));
            return;
          }

          const rawRequested = url.searchParams.get('raw') === '1';
          const widthParam = Number(url.searchParams.get('w') || '0');
          const hasExplicitWidth = Number.isFinite(widthParam) && widthParam > 0;
          const shouldCompressWebp =
            !rawRequested &&
            TRANSCODABLE_IMAGE_EXTS.has(ext) &&
            (ext === '.png' || hasExplicitWidth || stat.size > 45_000);

          if (shouldCompressWebp) {
            const maxW = hasExplicitWidth ? Math.max(64, Math.min(2400, Math.round(widthParam))) : 1600;
            const quality = maxW <= 480 ? 74 : 78;
            const cachedWebp = await this.transcodeToCachedWebp(filePath, stat, maxW, quality);
            if (cachedWebp && fs.existsSync(cachedWebp)) {
              const webpStat = fs.statSync(cachedWebp);
              res.writeHead(200, {
                'Content-Type': 'image/webp',
                'Content-Length': String(webpStat.size),
                'Cache-Control': 'private, max-age=3600',
              });
              fs.createReadStream(cachedWebp).pipe(res);
              return;
            }
          }

          const rangeHeader = typeof req.headers.range === 'string' ? req.headers.range : '';
          if (rangeHeader) {
            const match = rangeHeader.match(/bytes=(\d*)-(\d*)/);
            if (match) {
              const fileSize = stat.size;
              const start = match[1] ? Number(match[1]) : 0;
              const end = match[2] ? Math.min(Number(match[2]), fileSize - 1) : fileSize - 1;
              if (Number.isFinite(start) && Number.isFinite(end) && start >= 0 && start < fileSize && start <= end) {
                const chunkSize = end - start + 1;
                res.writeHead(206, {
                  'Content-Type': contentType,
                  'Content-Length': String(chunkSize),
                  'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                  'Accept-Ranges': 'bytes',
                  'Cache-Control': 'private, max-age=300',
                });
                fs.createReadStream(filePath, { start, end }).pipe(res);
                return;
              }
              res.writeHead(416, { 'Content-Range': `bytes */${fileSize}` });
              res.end();
              return;
            }
          }

          res.writeHead(200, {
            'Content-Type': contentType,
            'Content-Length': String(stat.size),
            'Accept-Ranges': 'bytes',
            // Transcoding was wanted but failed (often a damaged or partial image): don't let
            // clients cache this body.
            'Cache-Control': shouldCompressWebp ? 'no-store' : 'private, max-age=300',
          });
          fs.createReadStream(filePath).pipe(res);
          return;
        }

        if (req.method === 'GET' && url.pathname === '/api/harnesses') {
          const { harnesses } = await this.registry.discover();
          res.end(JSON.stringify({ harnesses }));
          return;
        }

        if (req.method === 'GET' && url.pathname === '/api/harnesses/updates') {
          sendJson({ ok: true, jobs: this.hooks.getHarnessUpdateJobs?.() ?? [] });
          return;
        }

        const updateRoute = url.pathname.match(/^\/api\/harnesses\/([a-z]+)\/update(\/cancel)?$/);
        if (req.method === 'POST' && updateRoute) {
          const harness = updateRoute[1] as HarnessGroup;
          if (!this.registry.getDriver(harness)) {
            sendJson({ ok: false, error: `Unknown harness: ${harness}` }, 404);
            return;
          }
          if (updateRoute[2]) {
            sendJson({ ok: this.hooks.cancelHarnessUpdate?.(harness) ?? false });
            return;
          }
          if (!this.hooks.startHarnessUpdate) {
            sendJson({ ok: false, error: 'Updates are not available on this host.' }, 404);
            return;
          }
          const result = this.hooks.startHarnessUpdate(harness);
          sendJson(result, result.ok ? 202 : 409);
          return;
        }

        if (req.method === 'GET' && url.pathname === '/api/sessions') {
          const { harnesses, sessions: rawSessions } = await this.registry.discover();
          const activeSet = new Set(this.hooks.getActiveWorkingSessionIds?.() ?? []);
          const sessions = rawSessions.map((s) =>
            !s.id.startsWith('master:') && activeSet.has(s.id) ? { ...s, status: 'running' as const } : s
          );
          const activeWorkingSessionIds = Array.from(
            new Set([
              ...activeSet,
              ...sessions
                .filter((s) => !s.id.startsWith('master:') && s.status === 'running')
                .map((s) => s.id),
            ])
          ).sort();
          const q = (url.searchParams.get('q') || '').toLowerCase();
          const harness = url.searchParams.get('harness') || '';
          const folderId = url.searchParams.get('folderId') || '';
          const liveOnly = url.searchParams.get('live') === 'true';
          const includeMaster = url.searchParams.get('includeMaster') === 'true';
          const filtered = sessions.filter((s) => {
            if (!includeMaster && s.harness === 'master') return false;
            if (liveOnly && !s.isLive) return false;
            if (harness && s.harness !== harness && s.harnessGroup !== harness) return false;
            if (folderId && s.folderId !== folderId) return false;
            if (
              q &&
              !`${s.title} ${s.projectName} ${s.cwd} ${s.preview} ${s.tags.join(' ')}`
                .toLowerCase()
                .includes(q)
            ) {
              return false;
            }
            return true;
          });
          sendJson({
            count: filtered.length,
            harnesses,
            sessions: filtered.slice(0, 200),
            activeWorkingSessionIds,
          });
          return;
        }

        if (req.method === 'GET' && url.pathname === '/api/folders') {
          const state = this.store.getState();
          const cached =
            typeof this.registry.getCached === 'function'
              ? this.registry.getCached()
              : { harnesses: [], sessions: [] };
          const { sessions } =
            cached.sessions.length > 0 ? cached : await this.registry.discover();
          const sessionFolderCounts: Record<string, number> = {};
          for (const s of sessions) {
            if (s.harness === 'master') continue;
            const ov = state.overrides[s.id];
            const fid = ov && 'folderId' in ov ? ov.folderId : s.folderId;
            if (!fid) continue;
            sessionFolderCounts[fid] = (sessionFolderCounts[fid] ?? 0) + 1;
          }
          sendJson({
            folders: state.folders,
            sidebarGroupBy: state.settings.sidebarGroupBy,
            sessionFolderCounts,
          });
          return;
        }

        if (req.method === 'GET' && url.pathname === '/api/transcript') {
          const sessionId = url.searchParams.get('sessionId') || '';
          const limit = Number(url.searchParams.get('limit') || '20');
          const compact = url.searchParams.get('compact') === '1' || url.searchParams.get('compact') === 'true';
          const tr = await this.registry.getTranscript(sessionId, Math.max(1, Math.min(limit, 200)));
          sendJson(compact ? compactTranscriptForMobile(tr) : tr);
          return;
        }

        if (req.method === 'GET' && url.pathname === '/api/usage') {
          if (!this.hooks.getUsage) {
            sendJson({ error: 'Usage endpoint not configured' }, 404);
            return;
          }
          const force = url.searchParams.get('force') === 'true';
          const usage = await this.hooks.getUsage(force);
          sendJson(usage);
          return;
        }

        if (req.method === 'GET' && url.pathname === '/api/catalog') {
          if (!this.hooks.getCatalog) {
            sendJson({ error: 'Catalog endpoint not configured' }, 404);
            return;
          }
          const force = url.searchParams.get('force') === 'true';
          const catalog = await this.hooks.getCatalog(force);
          sendJson(catalog);
          return;
        }

        if (req.method === 'POST' && url.pathname === '/api/send') {
          const body = await readBody();
          const sessionId = String(body.sessionId || '');
          const rawMessage = String(body.message ?? body.prompt ?? '');
          const rawAttachments = Array.isArray(body.attachments)
            ? (body.attachments as ImageAttachment[])
            : undefined;
          const mode = body.mode === 'queue' ? 'queue' : 'steer';

          // Pass images through native attachment slots and append file/video paths to prompt so all harnesses can access them.
          const imageAttachments: ImageAttachment[] = [];
          const fileNotes: string[] = [];
          for (const att of rawAttachments ?? []) {
            const mime = String(att.mimeType || '').toLowerCase();
            if (mime.startsWith('image/')) {
              imageAttachments.push(att);
            } else if (att.path) {
              const label = mime.startsWith('video/') ? 'Attached video' : 'Attached file';
              fileNotes.push(`[${label}: ${att.path}]`);
            }
          }
          const message =
            fileNotes.length > 0
              ? [rawMessage.trim(), ...fileNotes].filter(Boolean).join('\n\n')
              : rawMessage;
          const attachments = imageAttachments.length > 0 ? imageAttachments : undefined;

          // Default to immediate steer (force: true); long-press Queue sends mode: 'queue'.
          const result =
            mode === 'queue'
              ? this.hooks.queueMessage
                ? await this.hooks.queueMessage(sessionId, message, attachments)
                : await this.dispatcher.queueToSession(sessionId, message, attachments)
              : await (async () => {
                  const opts = { force: typeof body.force === 'boolean' ? body.force : true };
                  return this.hooks.sendMessage
                    ? this.hooks.sendMessage(sessionId, message, attachments, opts)
                    : this.dispatcher.sendToSession(sessionId, message, attachments, opts);
                })();

          if (result.ok && sessionId) {
            // Ensure liveSync is actively watching this session and immediately broadcast
            // live working activity. Do NOT fabricate transient `mobile-opt-*` messages
            // that vanish on the next disk poll before the harness flushes.
            void this.hooks.watchSession?.('mobile-active', sessionId, 20).catch(() => {});
            this.hooks.onMessageSent?.(sessionId);
          }

          sendJson(result);
          return;
        }

        if (req.method === 'POST' && url.pathname === '/api/abort') {
          const body = await readBody();
          const sessionId = String(body.sessionId || '');
          const result = this.hooks.abortRun
            ? await this.hooks.abortRun(sessionId)
            : { ok: this.dispatcher.abort(sessionId) };
          sendJson(result);
          return;
        }

        if (req.method === 'POST' && url.pathname === '/api/start') {
          const body = await readBody();
          const result = await this.dispatcher.startNewSession(
            body as unknown as StartSessionRequest
          );
          await this.triggerRefresh();
          sendJson(result);
          return;
        }

        if (req.method === 'POST' && url.pathname === '/api/sessions/read') {
          const body = await readBody();
          const sessionId = String(body.sessionId || '');
          if (!sessionId) {
            sendJson({ ok: false, error: 'sessionId required' }, 400);
            return;
          }
          if (body.unread === true) this.store.markUnread(sessionId);
          else this.store.markRead([{ sessionId, updatedAt: Date.now() }]);
          await this.triggerRefresh();
          sendJson({ ok: true, sessionId, unread: body.unread === true });
          return;
        }

        if (url.pathname === '/api/orchestrator/memory') {
          if (req.method === 'GET') {
            sendJson({ path: ORCHESTRATOR_MEMORY_PATH, content: readOrchestratorMemory() });
            return;
          }
          if (req.method === 'POST' || req.method === 'PUT') {
            const body = await readBody();
            const result = writeOrchestratorMemory(String(body.content ?? ''));
            sendJson({ ...result, path: ORCHESTRATOR_MEMORY_PATH }, result.ok ? 200 : 400);
            return;
          }
        }

        if (req.method === 'POST' && url.pathname === '/api/session-config') {
          const body = await readBody();
          const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
          const result = await this.dispatcher.updateSessionConfig(String(body.sessionId || ''), {
            model: str(body.model),
            reasoningEffort: str(body.reasoningEffort),
            permissionMode: str(body.permissionMode),
            restart: body.restart === true,
          });
          await this.triggerRefresh();
          sendJson(result, result.error && result.results.length === 0 ? 400 : 200);
          return;
        }

        if (req.method === 'POST' && url.pathname === '/api/organize') {
          const body = await readBody();
          const actions = Array.isArray(body.actions)
            ? (body.actions as OrganizeAction[])
            : [body as unknown as OrganizeAction];
          const state = this.store.applyOrganize(actions);
          await this.triggerRefresh();
          sendJson({ ok: true, folders: state.folders, state });
          return;
        }

        if (req.method === 'POST' && url.pathname === '/api/archive') {
          const body = await readBody();
          const sessionId = String(body.sessionId || '');
          const killTmux = Boolean(body.killTmux);
          const result = await this.dispatcher.archiveSession(sessionId, { killTmux });
          await this.triggerRefresh();
          sendJson(result);
          return;
        }

        if (req.method === 'POST' && url.pathname === '/api/attachments') {
          if (!this.hooks.saveAttachment && !this.hooks.saveRawAttachment) {
            sendJson({ error: 'Attachments endpoint not configured' }, 404);
            return;
          }
          const reqContentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
          if (reqContentType && reqContentType !== 'application/json' && this.hooks.saveRawAttachment) {
            const rawBuf = await readRawBody(55 * 1024 * 1024);
            if (rawBuf.length === 0) {
              sendJson({ error: 'Empty attachment payload' }, 400);
              return;
            }
            const headerName = String(req.headers['x-filename'] || url.searchParams.get('filename') || '').trim();
            const decodedName = headerName ? decodeURIComponent(headerName) : undefined;
            const attachment = await this.hooks.saveRawAttachment(rawBuf, reqContentType, decodedName);
            sendJson(
              attachment.path
                ? { ...attachment, previewDataUrl: undefined }
                : attachment
            );
            return;
          }
          const body = await readBody();
          const dataUrl = String(body.dataUrl || '');
          const filename = body.filename ? String(body.filename) : undefined;
          const attachment = await this.hooks.saveAttachment!(dataUrl, filename);
          // Avoid echoing multi-MB base64 dataUrl back down cellular/Tailscale links when saved to disk.
          sendJson(
            attachment.path
              ? { ...attachment, previewDataUrl: undefined }
              : attachment
          );
          return;
        }

        if (req.method === 'POST' && url.pathname === '/api/push/register') {
          if (!this.hooks.registerPushDevice) {
            sendJson({ ok: false, error: 'Push notifications not configured on host' }, 404);
            return;
          }
          const body = await readBody();
          const record = this.hooks.registerPushDevice({
            rid: typeof body.rid === 'string' ? body.rid : undefined,
            relayUrl: typeof body.relayUrl === 'string' ? body.relayUrl : undefined,
            enabled: typeof body.enabled === 'boolean' ? body.enabled : true,
            authToken: bearer,
            pairedDeviceId: authResult.kind === 'device' ? authResult.deviceId : undefined,
          });
          sendJson({ ok: Boolean(record), device: record });
          return;
        }

        if (req.method === 'POST' && url.pathname === '/api/push/test') {
          if (!this.hooks.sendTestPush) {
            sendJson({ ok: false, error: 'Push notifications not configured on host' }, 404);
            return;
          }
          const body = await readBody();
          const result = await this.hooks.sendTestPush({
            title: typeof body.title === 'string' ? body.title : undefined,
            body: typeof body.body === 'string' ? body.body : undefined,
          });
          sendJson({ ok: true, result });
          return;
        }

        if (req.method === 'GET' && url.pathname === '/api/files/preview') {
          if (!this.hooks.readFilePreview) {
            sendJson({ error: 'File preview endpoint not configured' }, 404);
            return;
          }
          const filePath = url.searchParams.get('path') || '';
          const startLine = url.searchParams.get('startLine')
            ? Number(url.searchParams.get('startLine'))
            : undefined;
          const endLine = url.searchParams.get('endLine')
            ? Number(url.searchParams.get('endLine'))
            : undefined;
          const preview = await this.hooks.readFilePreview(filePath, startLine, endLine);
          sendJson(preview);
          return;
        }

        if (req.method === 'POST' && url.pathname === '/api/settings') {
          const body = await readBody();
          for (const key of HOST_ONLY_SETTING_KEYS) delete body[key];
          const state = this.store.updateSettings(body as Partial<SuperHarnessSettings>);
          await this.triggerRefresh();
          sendJson({ ok: true, settings: redactStateForClients(state).settings });
          return;
        }

        if (req.method === 'POST' && url.pathname === '/api/control-harness') {
          const body = await readBody();
          const result = await this.dispatcher.controlHarness(
            body.harness as HarnessGroup,
            body.action as 'start_remote' | 'stop_remote' | 'open_desktop'
          );
          await this.triggerRefresh();
          sendJson(result);
          return;
        }

        if (req.method === 'GET' && url.pathname === '/api/summaries') {
          sendJson({ summaries: this.hooks.getSummaries?.() ?? {} });
          return;
        }

        if (req.method === 'POST' && url.pathname === '/api/summaries/refresh') {
          const body = await readBody();
          if (!this.hooks.refreshSummaries) {
            sendJson({ ok: false, error: 'Summaries not configured' }, 404);
            return;
          }
          const sessionIds = Array.isArray(body.sessionIds)
            ? body.sessionIds.filter((x: unknown): x is string => typeof x === 'string')
            : undefined;
          sendJson(await this.hooks.refreshSummaries({ force: Boolean(body.force), sessionIds }));
          return;
        }

        if (req.method === 'POST' && url.pathname === '/api/restart') {
          const body = await readBody();
          if (!this.hooks.restartApp) {
            sendJson({ ok: false, error: 'Restart hook not configured' }, 404);
            return;
          }
          const result = await this.hooks.restartApp({
            build: Boolean(body.build),
          });
          sendJson(result);
          return;
        }

        sendJson({ error: 'Not found' }, 404);
      } catch (err) {
        sendJson(
          {
            error: err instanceof Error ? err.message : String(err),
          },
          500
        );
      }
    };
  }

  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      const srv = http.createServer(
        this.createRequestHandler((bearer) => (bearer === this.token ? { kind: 'legacy' } : null))
      );
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address();
        if (addr && typeof addr === 'object') {
          this.port = addr.port;
          this.server = srv;
          resolve(this.port);
        } else {
          reject(new Error('Failed to bind control server'));
        }
      });
      srv.on('error', reject);
    });
  }

  async syncMobileListener(cfg?: MobileApiSettings): Promise<number> {
    if (!cfg || !cfg.enabled) {
      this.closeMobileListener();
      return 0;
    }
    const host = cfg.bindHost || '0.0.0.0';
    const port = Number.isFinite(cfg.port) && cfg.port >= 0 ? cfg.port : 47890;
    const nextKey = `${host}:${port}:${cfg.token}`;
    if (this.mobileServer && this.mobileConfigKey === nextKey) {
      return this.mobilePort;
    }

    this.closeMobileListener();

    return new Promise((resolve) => {
      const legacyToken = cfg.token;
      const srv = http.createServer(
        this.createRequestHandler(
          (bearer) =>
            this.hooks.pairing
              ? this.hooks.pairing.authenticate(bearer, legacyToken)
              : legacyToken && bearer === legacyToken
                ? { kind: 'legacy' }
                : null,
          { mobile: true }
        )
      );
      // Keep phone connections open between requests. Node's 5s default closes the connection
      // between a mic tap and the audio upload, so every dictation paid for a new handshake.
      srv.keepAliveTimeout = 75_000;
      srv.headersTimeout = 80_000;
      srv.on('error', (err) => {
        console.error('[ControlServer] Mobile API listener failed:', err);
        this.mobileServer = null;
        this.mobilePort = 0;
        this.mobileConfigKey = '';
        resolve(0);
      });
      srv.listen(port, host, () => {
        const addr = srv.address();
        if (addr && typeof addr === 'object') {
          this.mobileServer = srv;
          this.mobilePort = addr.port;
          this.mobileConfigKey = nextKey;
          console.log(`[ControlServer] Mobile API listening on http://${host}:${addr.port}`);
          resolve(addr.port);
        } else {
          resolve(0);
        }
      });
    });
  }

  private closeMobileListener(): void {
    if (this.mobileServer) {
      this.mobileServer.close();
      this.mobileServer = null;
    }
    this.mobilePort = 0;
    this.mobileConfigKey = '';
  }

  close(): void {
    if (this.sseKeepaliveTimer) {
      clearInterval(this.sseKeepaliveTimer);
      this.sseKeepaliveTimer = null;
    }
    for (const client of this.sseClients) {
      try {
        client.end();
      } catch {
        // ignore
      }
    }
    this.sseClients.clear();
    this.closeMobileListener();
    this.server?.close();
    this.server = null;
  }
}
