import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
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
  private sseClientIdByRes = new Map<http.ServerResponse, string>();
  private watchedSessionByClient = new Map<string, string | null>();
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

    // Cap mobile SSE transcript payloads to the tail 20 messages so a single frame never sends ~800 KB.
    let payload: unknown = data;
    if (event === 'transcript' && data && typeof data === 'object') {
      const tr = data as { messages?: unknown[]; hasMore?: boolean };
      if (Array.isArray(tr.messages) && tr.messages.length > 20) {
        payload = {
          ...tr,
          messages: tr.messages.slice(-20),
          hasMore: true,
        };
      }
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
        client.write(frame);
      } catch {
        this.sseClients.delete(client);
      }
    }
  }

  private ensureKeepalive(): void {
    if (this.sseKeepaliveTimer) return;
    this.sseKeepaliveTimer = setInterval(() => {
      if (this.sseClients.size === 0) return;
      for (const client of this.sseClients) {
        try {
          client.write(': ping\n\n');
        } catch {
          this.sseClients.delete(client);
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
      const readRawBody = async (): Promise<Buffer> => {
        const chunks: Buffer[] = [];
        let total = 0;
        const maxBytes = 25 * 1024 * 1024;
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
          const audioBuf = await readRawBody();
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

          const upRes = await fetch(`${targetUrl}/v1/audio/transcriptions`, {
            method: 'POST',
            headers,
            body: form,
          });
          const rawText = await upRes.text();
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
          sendJson({ ok: true, text });
          return;
        }

        if (req.method === 'GET' && url.pathname === '/api/events') {
          const clientId = (url.searchParams.get('clientId') || '').trim();
          const lastEventRaw =
            (req.headers['last-event-id'] as string | undefined) ||
            url.searchParams.get('lastEventId') ||
            '';
          const lastSeq = lastEventRaw ? Number(lastEventRaw) : 0;

          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });
          res.write(
            `id: ${this.eventSeq}\nevent: connected\ndata: ${JSON.stringify({
              ok: true,
              protocolVersion: MOBILE_PROTOCOL_VERSION,
              seq: this.eventSeq,
            })}\n\n`
          );

          if (Number.isFinite(lastSeq) && lastSeq > 0) {
            if (lastSeq > this.eventSeq) {
              res.write(
                `id: ${this.eventSeq}\nevent: resync_required\ndata: ${JSON.stringify({
                  reason: 'host_restarted',
                  lastSeq,
                  currentSeq: this.eventSeq,
                })}\n\n`
              );
            } else if (lastSeq < this.eventSeq) {
              const oldestSeq = this.eventBuffer[0]?.seq ?? this.eventSeq + 1;
              if (lastSeq + 1 < oldestSeq) {
                res.write(
                  `id: ${this.eventSeq}\nevent: resync_required\ndata: ${JSON.stringify({
                    reason: 'buffer_gap',
                    lastSeq,
                    currentSeq: this.eventSeq,
                  })}\n\n`
                );
              } else {
                if (clientId) this.sseClientIdByRes.set(res, clientId);
                for (const item of this.eventBuffer) {
                  if (item.seq > lastSeq && this.shouldDeliver(res, item)) {
                    res.write(item.frame);
                  }
                }
              }
            }
          }

          if (clientId) this.sseClientIdByRes.set(res, clientId);
          this.sseClients.add(res);
          this.ensureKeepalive();
          req.on('close', () => {
            this.sseClients.delete(res);
            this.sseClientIdByRes.delete(res);
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
          const liveOnly = url.searchParams.get('live') === 'true';
          const includeMaster = url.searchParams.get('includeMaster') === 'true';
          const filtered = sessions.filter((s) => {
            if (!includeMaster && s.harness === 'master') return false;
            if (liveOnly && !s.isLive) return false;
            if (harness && s.harness !== harness && s.harnessGroup !== harness) return false;
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

        if (req.method === 'GET' && url.pathname === '/api/transcript') {
          const sessionId = url.searchParams.get('sessionId') || '';
          const limit = Number(url.searchParams.get('limit') || '20');
          const tr = await this.registry.getTranscript(sessionId, Math.max(1, Math.min(limit, 200)));
          sendJson(tr);
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
          const message = String(body.message ?? body.prompt ?? '');
          const attachments = Array.isArray(body.attachments)
            ? (body.attachments as ImageAttachment[])
            : undefined;
          const opts =
            typeof body.force === 'boolean' ? { force: body.force } : undefined;
          const result = this.hooks.sendMessage
            ? await this.hooks.sendMessage(sessionId, message, attachments, opts)
            : await this.dispatcher.sendToSession(sessionId, message, attachments, opts);

          if (result.ok && sessionId) {
            // Ensure liveSync is actively watching this session and immediately push
            // a fresh transcript snapshot (with an optimistic user turn if the harness
            // hasn't flushed to disk yet) so mobile composers see submitted turns right away.
            void this.hooks.watchSession?.('mobile-active', sessionId, 20).catch(() => {});
            this.hooks.onMessageSent?.(sessionId);
            void (async () => {
              try {
                const tr = await this.registry.getTranscript(sessionId, 20);
                const trimmed = message.trim();
                const lastUser = [...tr.messages].reverse().find((m) => m.role === 'user');
                const lastUserText = lastUser?.blocks
                  .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
                  .map((b) => b.text.trim())
                  .join('\n')
                  .trim();
                const alreadyPersisted = Boolean(trimmed && lastUserText === trimmed);
                const now = Date.now();
                const messages = alreadyPersisted
                  ? tr.messages
                  : [
                      ...tr.messages,
                      {
                        id: `mobile-opt-${now}`,
                        role: 'user' as const,
                        timestamp: now,
                        blocks: [
                          ...(attachments ?? []).map((a) => ({
                            type: 'image' as const,
                            path: a.path,
                            name: a.name,
                            dataUrl: a.previewDataUrl,
                          })),
                          ...(trimmed ? [{ type: 'text' as const, text: trimmed }] : []),
                        ],
                      },
                    ];
                const nextTranscript = {
                  ...tr,
                  messages,
                  totalCount: alreadyPersisted ? tr.totalCount : tr.totalCount + 1,
                  liveActivity: {
                    ...(tr.liveActivity ?? { isWorking: true }),
                    isWorking: true,
                    lastEventAt: now,
                  },
                };
                this.broadcastEvent('transcript', nextTranscript);
                this.broadcastEvent('transcript_updated', {
                  sessionId: nextTranscript.sessionId,
                  totalCount: nextTranscript.totalCount,
                  liveActivity: nextTranscript.liveActivity,
                });
              } catch {
                // best-effort optimistic push; liveSync follow-ups will still deliver
              }
            })();
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
          if (!this.hooks.saveAttachment) {
            sendJson({ error: 'Attachments endpoint not configured' }, 404);
            return;
          }
          const body = await readBody();
          const dataUrl = String(body.dataUrl || '');
          const filename = body.filename ? String(body.filename) : undefined;
          const attachment = await this.hooks.saveAttachment(dataUrl, filename);
          // Avoid echoing multi-MB base64 dataUrl back down cellular/Tailscale links when saved to disk.
          sendJson(
            attachment.path
              ? { ...attachment, previewDataUrl: undefined }
              : attachment
          );
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
