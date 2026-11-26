import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
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

export const MOBILE_PROTOCOL_VERSION = 1;

export interface ControlServerHooks {
  getUsage?: (force: boolean) => Promise<UsageSnapshot>;
  getCatalog?: (force: boolean) => Promise<HarnessCatalog>;
  sendMessage?: (
    sessionId: string,
    prompt: string,
    attachments?: ImageAttachment[]
  ) => Promise<SendMessageResult>;
  abortRun?: (sessionId: string) => Promise<{ ok: boolean }>;
  saveAttachment?: (dataUrl: string, filename?: string) => Promise<ImageAttachment>;
  readFilePreview?: (
    filePath: string,
    startLine?: number,
    endLine?: number
  ) => Promise<FilePreviewData>;
  watchSession?: (paneId: string, sessionId: string | null, limit?: number) => Promise<void>;
}

interface BufferedEvent {
  seq: number;
  event: string;
  frame: string;
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

  broadcastEvent(event: string, data: unknown): void {
    const seq = ++this.eventSeq;
    const frame = `id: ${seq}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    this.eventBuffer.push({ seq, event, frame });
    if (this.eventBuffer.length > this.maxBufferedEvents) {
      this.eventBuffer.splice(0, this.eventBuffer.length - this.maxBufferedEvents);
    }
    if (this.sseClients.size === 0) return;
    for (const client of this.sseClients) {
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
      res.setHeader('Content-Type', 'application/json');
      const auth = req.headers.authorization;
      if (!expectedToken || auth !== `Bearer ${expectedToken}`) {
        res.statusCode = 401;
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }

      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const readBody = async (): Promise<Record<string, unknown>> => {
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
        const raw = Buffer.concat(chunks).toString('utf8').trim();
        return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      };

      try {
        if (req.method === 'GET' && url.pathname === '/api/health') {
          res.end(
            JSON.stringify({
              ok: true,
              protocolVersion: MOBILE_PROTOCOL_VERSION,
              seq: this.eventSeq,
              uptimeMs: Date.now() - this.startedAt,
            })
          );
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

          if (Number.isFinite(lastSeq) && lastSeq > 0 && lastSeq < this.eventSeq) {
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
              for (const item of this.eventBuffer) {
                if (item.seq > lastSeq) {
                  res.write(item.frame);
                }
              }
            }
          }

          this.sseClients.add(res);
          this.ensureKeepalive();
          req.on('close', () => {
            this.sseClients.delete(res);
            if (clientId && this.hooks.watchSession) {
              void this.hooks.watchSession(`mobile:${clientId}`, null);
            }
          });
          return;
        }

        if (req.method === 'GET' && url.pathname === '/api/bootstrap') {
          const { harnesses, sessions } = await this.registry.discover();
          const [usage, catalog] = await Promise.all([
            this.hooks.getUsage ? this.hooks.getUsage(false).catch(() => undefined) : Promise.resolve(undefined),
            this.hooks.getCatalog ? this.hooks.getCatalog(false).catch(() => undefined) : Promise.resolve(undefined),
          ]);
          res.end(
            JSON.stringify({
              protocolVersion: MOBILE_PROTOCOL_VERSION,
              seq: this.eventSeq,
              harnesses,
              sessions,
              state: this.store.getState(),
              usage,
              catalog,
            })
          );
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
          const { harnesses, sessions } = await this.registry.discover();
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
          res.end(
            JSON.stringify({
              count: filtered.length,
              harnesses,
              sessions: filtered.slice(0, 200),
            })
          );
          return;
        }

        if (req.method === 'GET' && url.pathname === '/api/transcript') {
          const sessionId = url.searchParams.get('sessionId') || '';
          const limit = Number(url.searchParams.get('limit') || '40');
          const tr = await this.registry.getTranscript(sessionId, Math.max(1, Math.min(limit, 200)));
          res.end(JSON.stringify(tr));
          return;
        }

        if (req.method === 'GET' && url.pathname === '/api/usage') {
          if (!this.hooks.getUsage) {
            res.statusCode = 404;
            res.end(JSON.stringify({ error: 'Usage endpoint not configured' }));
            return;
          }
          const force = url.searchParams.get('force') === 'true';
          const usage = await this.hooks.getUsage(force);
          res.end(JSON.stringify(usage));
          return;
        }

        if (req.method === 'GET' && url.pathname === '/api/catalog') {
          if (!this.hooks.getCatalog) {
            res.statusCode = 404;
            res.end(JSON.stringify({ error: 'Catalog endpoint not configured' }));
            return;
          }
          const force = url.searchParams.get('force') === 'true';
          const catalog = await this.hooks.getCatalog(force);
          res.end(JSON.stringify(catalog));
          return;
        }

        if (req.method === 'POST' && url.pathname === '/api/send') {
          const body = await readBody();
          const sessionId = String(body.sessionId || '');
          const message = String(body.message || '');
          const attachments = Array.isArray(body.attachments)
            ? (body.attachments as ImageAttachment[])
            : undefined;
          const result = this.hooks.sendMessage
            ? await this.hooks.sendMessage(sessionId, message, attachments)
            : await this.dispatcher.sendToSession(sessionId, message, attachments);
          res.end(JSON.stringify(result));
          return;
        }

        if (req.method === 'POST' && url.pathname === '/api/abort') {
          const body = await readBody();
          const sessionId = String(body.sessionId || '');
          const result = this.hooks.abortRun
            ? await this.hooks.abortRun(sessionId)
            : { ok: this.dispatcher.abort(sessionId) };
          res.end(JSON.stringify(result));
          return;
        }

        if (req.method === 'POST' && url.pathname === '/api/start') {
          const body = await readBody();
          const result = await this.dispatcher.startNewSession(
            body as unknown as StartSessionRequest
          );
          await this.triggerRefresh();
          res.end(JSON.stringify(result));
          return;
        }

        if (req.method === 'POST' && url.pathname === '/api/organize') {
          const body = await readBody();
          const actions = Array.isArray(body.actions)
            ? (body.actions as OrganizeAction[])
            : [body as unknown as OrganizeAction];
          const state = this.store.applyOrganize(actions);
          await this.triggerRefresh();
          res.end(JSON.stringify({ ok: true, folders: state.folders, state }));
          return;
        }

        if (req.method === 'POST' && url.pathname === '/api/archive') {
          const body = await readBody();
          const sessionId = String(body.sessionId || '');
          const killTmux = Boolean(body.killTmux);
          const result = await this.dispatcher.archiveSession(sessionId, { killTmux });
          await this.triggerRefresh();
          res.end(JSON.stringify(result));
          return;
        }

        if (req.method === 'POST' && url.pathname === '/api/attachments') {
          if (!this.hooks.saveAttachment) {
            res.statusCode = 404;
            res.end(JSON.stringify({ error: 'Attachments endpoint not configured' }));
            return;
          }
          const body = await readBody();
          const dataUrl = String(body.dataUrl || '');
          const filename = body.filename ? String(body.filename) : undefined;
          const attachment = await this.hooks.saveAttachment(dataUrl, filename);
          res.end(JSON.stringify(attachment));
          return;
        }

        if (req.method === 'GET' && url.pathname === '/api/files/preview') {
          if (!this.hooks.readFilePreview) {
            res.statusCode = 404;
            res.end(JSON.stringify({ error: 'File preview endpoint not configured' }));
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
          res.end(JSON.stringify(preview));
          return;
        }

        if (req.method === 'POST' && url.pathname === '/api/settings') {
          const body = await readBody();
          const state = this.store.updateSettings(body as Partial<SuperHarnessSettings>);
          await this.triggerRefresh();
          res.end(JSON.stringify({ ok: true, settings: state.settings }));
          return;
        }

        if (req.method === 'POST' && url.pathname === '/api/control-harness') {
          const body = await readBody();
          const result = await this.dispatcher.controlHarness(
            body.harness as HarnessGroup,
            body.action as 'start_remote' | 'stop_remote' | 'open_desktop'
          );
          await this.triggerRefresh();
          res.end(JSON.stringify(result));
          return;
        }

        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'Not found' }));
      } catch (err) {
        res.statusCode = 500;
        res.end(
          JSON.stringify({
            error: err instanceof Error ? err.message : String(err),
          })
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
