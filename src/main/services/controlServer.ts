import { execFile } from 'node:child_process';
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
  registerPushDevice?: (opts: { rid?: string; relayUrl?: string; enabled?: boolean }) => unknown;
  sendTestPush?: (opts?: { title?: string; body?: string }) => Promise<unknown>;
  readFilePreview?: (
    filePath: string,
    startLine?: number,
    endLine?: number
  ) => Promise<FilePreviewData>;
  watchSession?: (paneId: string, sessionId: string | null, limit?: number) => Promise<void>;
  getActiveWorkingSessionIds?: () => string[];
  restartApp?: (opts?: { build?: boolean }) => Promise<{ ok: boolean; error?: string }>;
}

interface BufferedEvent {
  seq: number;
  event: string;
  frame: string;
  /** Set for per-session events (transcripts) so they only reach clients watching that session. */
  sessionId?: string;
}

const SESSION_SCOPED_EVENTS = new Set(['transcript', 'transcript_updated']);

interface DictationServerConfig {
  url: string;
  token: string;
}

function readLocalYapYapConfig(): DictationServerConfig | null {
  try {
    const cfgPath = path.join(os.homedir(), '.config', 'yapyap', 'config.toml');
    if (!fs.existsSync(cfgPath)) return null;
    const raw = fs.readFileSync(cfgPath, 'utf8');
    let inServer = false;
    let url = '';
    let token = '';
    for (const rawLine of raw.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      if (line.startsWith('[')) {
        inServer = line === '[server]';
        continue;
      }
      if (!inServer) continue;
      const urlMatch = line.match(/^url\s*=\s*["']([^"']+)["']/);
      if (urlMatch) url = urlMatch[1].replace(/\/+$/, '');
      const tokMatch = line.match(/^token\s*=\s*["']([^"']+)["']/);
      if (tokMatch) token = tokMatch[1];
    }
    if (!url) return null;
    return { url, token };
  } catch {
    return null;
  }
}

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
export class ControlServer {
  private server: http.Server | null = null;
  private mobileServer: http.Server | null = null;
  private mobileConfigKey = '';
  private sseClients = new Set<http.ServerResponse>();
  private sseGzipByRes = new Map<http.ServerResponse, zlib.Gzip>();
  private sseClientIdByRes = new Map<http.ServerResponse, string>();
  private watchedSessionByClient = new Map<string, string | null>();
  private webpInFlight = new Map<string, Promise<string | null>>();
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

  private createRequestHandler(expectedToken: string): http.RequestListener {
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
          const gz = zlib.gzipSync(buf, { level: 6 });
          res.setHeader('Content-Encoding', 'gzip');
          res.setHeader('Vary', 'Accept-Encoding');
          res.setHeader('Content-Length', String(gz.length));
          res.end(gz);
        } else {
          res.setHeader('Content-Length', String(buf.length));
          res.end(buf);
        }
      };

      const auth = req.headers.authorization;
      if (!expectedToken || auth !== `Bearer ${expectedToken}`) {
        sendJson({ error: 'Unauthorized' }, 401);
        return;
      }

      const url = new URL(req.url || '/', 'http://127.0.0.1');
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
          const overrideUrl = String(req.headers['x-dictation-url'] || '').trim().replace(/\/+$/, '');
          const cfg = overrideUrl
            ? { url: overrideUrl, token: String(req.headers['x-dictation-token'] || '') }
            : readLocalYapYapConfig();
          if (!cfg) {
            sendJson({ ok: true, configured: false, healthy: false });
            return;
          }
          try {
            const ac = new AbortController();
            const timer = setTimeout(() => ac.abort(), 3000);
            const hRes = await fetch(`${cfg.url}/health`, { signal: ac.signal });
            clearTimeout(timer);
            const info = hRes.ok ? ((await hRes.json().catch(() => ({}))) as Record<string, unknown>) : {};
            sendJson({
              ok: true,
              configured: true,
              url: cfg.url,
              healthy: hRes.ok,
              model: typeof info.model === 'string' ? info.model : undefined,
            });
          } catch (err) {
            sendJson({
              ok: true,
              configured: true,
              url: cfg.url,
              healthy: false,
              error: err instanceof Error ? err.message : String(err),
            });
          }
          return;
        }

        if (req.method === 'POST' && url.pathname === '/api/dictate') {
          const overrideUrl = String(req.headers['x-dictation-url'] || '').trim().replace(/\/+$/, '');
          const overrideToken = String(req.headers['x-dictation-token'] || '').trim();
          const localCfg = readLocalYapYapConfig();
          const targetUrl = overrideUrl || localCfg?.url || '';
          const targetToken = overrideUrl ? overrideToken : localCfg?.token || '';
          if (!targetUrl) {
            sendJson({ ok: false, error: 'Dictation server not configured on host (~/.config/yapyap/config.toml)' }, 503);
            return;
          }
          const t0 = Date.now();
          const audioBuf = await readRawBody();
          const readMs = Date.now() - t0;
          if (audioBuf.length === 0) {
            sendJson({ ok: false, error: 'Empty audio payload' }, 400);
            return;
          }
          const contentType = String(req.headers['content-type'] || 'audio/wav').split(';')[0].trim();
          const ext = contentType.includes('m4a') || contentType.includes('mp4')
            ? 'm4a'
            : contentType.includes('ogg')
              ? 'ogg'
              : 'wav';
          const language = url.searchParams.get('language') || '';
          const prompt = url.searchParams.get('prompt') || '';

          const form = new FormData();
          form.append('file', new Blob([new Uint8Array(audioBuf)], { type: contentType }), `dictation.${ext}`);
          if (language) form.append('language', language);
          if (prompt) form.append('prompt', prompt);
          form.append('response_format', 'json');

          const headers: Record<string, string> = {};
          if (targetToken) headers.Authorization = `Bearer ${targetToken}`;

          const tUp = Date.now();
          const upRes = await fetch(`${targetUrl}/v1/audio/transcriptions`, {
            method: 'POST',
            headers,
            body: form,
          });
          const rawText = await upRes.text();
          const yapyapMs = Date.now() - tUp;
          console.log(
            `[ControlServer] /api/dictate ${ext} ${audioBuf.length}B read=${readMs}ms yapyap=${yapyapMs}ms status=${upRes.status}`
          );
          if (!upRes.ok) {
            sendJson({ ok: false, error: `YapYap HTTP ${upRes.status}: ${rawText.slice(0, 240)}` }, 502);
            return;
          }
          let text = rawText.trim();
          try {
            const parsed = JSON.parse(rawText) as { text?: string };
            if (typeof parsed.text === 'string') text = parsed.text.trim();
          } catch {
            // plain text response
          }
          // `timing` lets clients separate YapYap time from network/proxy overhead.
          sendJson({ ok: true, text, timing: { readMs, yapyapMs } });
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
            state: this.store.getState(),
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
          const filePath = url.searchParams.get('path') || '';
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

          res.writeHead(200, {
            'Content-Type': contentType,
            'Content-Length': String(stat.size),
            'Cache-Control': 'private, max-age=300',
          });
          fs.createReadStream(filePath).pipe(res);
          return;
        }

        if (req.method === 'GET' && url.pathname === '/api/harnesses') {
          const { harnesses } = await this.registry.discover();
          res.end(JSON.stringify({ harnesses }));
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
          const state = this.store.updateSettings(body as Partial<SuperHarnessSettings>);
          await this.triggerRefresh();
          sendJson({ ok: true, settings: state.settings });
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
      const srv = http.createServer(this.createRequestHandler(this.token));
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
    if (!cfg || !cfg.enabled || !cfg.token) {
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
      const srv = http.createServer(this.createRequestHandler(cfg.token));
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
