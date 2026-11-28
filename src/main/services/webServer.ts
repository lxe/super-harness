import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { EVENT_CHANNELS, INVOKE_CHANNELS } from '../../shared/ipcChannels';

export type WebHandler = (...args: unknown[]) => unknown;

export interface WebServerOptions {
  host: string;
  port: number;
  token: string;
  /** The built renderer (dist/renderer). */
  rendererDir: string;
  /** The desktop app's IPC handlers, by channel. */
  handlers: Map<string, WebHandler>;
  /** Serves `sh-media://local?…` requests; the browser asks for `media?…` instead. */
  media: (request: Request) => Response | Promise<Response>;
}

const COOKIE = 'sh_web';
const MAX_BODY = 64 * 1024 * 1024;
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

/**
 * Web mode: serves the desktop renderer to a browser and stands in for Electron IPC. The page
 * gets a `window.superHarness` built from the same channel table as the preload; calls become
 * `POST rpc/<channel>` and pushed events arrive over server-sent events. A token, exchanged
 * once for a cookie, guards every route.
 */
export class WebServer {
  private server: http.Server | null = null;
  private clients = new Set<http.ServerResponse>();
  private heartbeat: NodeJS.Timeout | null = null;

  constructor(private readonly opts: WebServerOptions) {}

  get port(): number {
    const addr = this.server?.address();
    return addr && typeof addr === 'object' ? addr.port : this.opts.port;
  }

  broadcast(channel: string, payload: unknown): void {
    if (this.clients.size === 0) return;
    const frame = `data: ${JSON.stringify({ channel, payload })}\n\n`;
    for (const c of this.clients) c.write(frame);
  }

  start(): Promise<void> {
    const server = http.createServer((req, res) => {
      void this.route(req, res).catch((err) => {
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(String(err instanceof Error ? err.message : err));
      });
    });
    this.server = server;
    this.heartbeat = setInterval(() => {
      for (const c of this.clients) c.write(': ping\n\n');
    }, 25_000);
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.opts.port, this.opts.host, () => resolve());
    });
  }

  close(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const c of this.clients) c.end();
    this.clients.clear();
    this.server?.close();
    this.server = null;
  }

  private authorized(req: http.IncomingMessage, url: URL): 'cookie' | 'query' | null {
    const ok = (candidate: string | undefined) => {
      if (!candidate) return false;
      const a = Buffer.from(candidate);
      const b = Buffer.from(this.opts.token);
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    };
    const cookie = (req.headers.cookie ?? '')
      .split(';')
      .map((c) => c.trim().split('='))
      .find(([k]) => k === COOKIE)?.[1];
    if (ok(cookie ? decodeURIComponent(cookie) : undefined)) return 'cookie';
    if (ok(url.searchParams.get('token') ?? undefined)) return 'query';
    return null;
  }

  private async route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://local');
    const auth = this.authorized(req, url);
    if (!auth) {
      res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Superharness web: open the link that includes ?token=… (see ~/.config/super-harness/web.json on the server).');
      return;
    }
    if (auth === 'query') {
      // Trade the token for a cookie and drop it from the address bar.
      url.searchParams.delete('token');
      const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
      res.writeHead(303, {
        'Set-Cookie': `${COOKIE}=${encodeURIComponent(this.opts.token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000${secure}`,
        Location: `${url.pathname}${url.search}`,
      });
      res.end();
      return;
    }

    if (req.method === 'POST' && url.pathname.startsWith('/rpc/')) return this.rpc(req, res, decodeURIComponent(url.pathname.slice(5)));
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    if (url.pathname === '/events') return this.events(req, res);
    if (url.pathname === '/web-bridge.js') {
      res.writeHead(200, { 'Content-Type': MIME['.js'], 'Cache-Control': 'no-store' });
      res.end(bridgeScript());
      return;
    }
    if (url.pathname === '/media') return this.mediaRoute(req, res, url);
    return this.staticFile(res, url.pathname);
  }

  private async rpc(req: http.IncomingMessage, res: http.ServerResponse, channel: string): Promise<void> {
    // A custom header forces a CORS preflight, which this server never answers, so other sites
    // cannot post here with the cookie.
    if (req.headers['x-superharness'] !== '1') {
      res.writeHead(403).end();
      return;
    }
    const handler = this.opts.handlers.get(channel);
    if (!handler) {
      sendJson(res, 404, { error: `Unknown channel ${channel}` });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY) {
        sendJson(res, 413, { error: 'Request too large' });
        return;
      }
      chunks.push(chunk as Buffer);
    }
    const args = JSON.parse(Buffer.concat(chunks).toString('utf8') || '[]', (_k, v) =>
      v && typeof v === 'object' && typeof (v as { __u8?: unknown }).__u8 === 'string'
        ? Buffer.from((v as { __u8: string }).__u8, 'base64')
        : v
    ) as unknown[];
    try {
      const result = await handler(...(Array.isArray(args) ? args : []));
      sendJson(res, 200, { result });
    } catch (err) {
      sendJson(res, 200, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private events(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    this.clients.add(res);
    req.on('close', () => this.clients.delete(res));
  }

  private async mediaRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    const headers = new Headers();
    if (typeof req.headers.range === 'string') headers.set('range', req.headers.range);
    const out = await this.opts.media(new Request(`http://local/media${url.search}`, { headers }));
    res.writeHead(out.status, Object.fromEntries(out.headers.entries()));
    if (!out.body || req.method === 'HEAD') {
      res.end();
      return;
    }
    Readable.fromWeb(out.body as never).pipe(res);
  }

  private staticFile(res: http.ServerResponse, pathname: string): void {
    const root = path.resolve(this.opts.rendererDir);
    const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
    const file = path.resolve(root, rel);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    const ext = path.extname(file).toLowerCase();
    if (rel === 'index.html') {
      const html = fs
        .readFileSync(file, 'utf8')
        .replace(/<head\b[^>]*>/i, (m) => `${m}\n<script>window.__SH_WEB__=true</script><script src="./web-bridge.js"></script>`);
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
      res.end(html);
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream', 'Cache-Control': 'public, max-age=3600' });
    fs.createReadStream(file).pipe(res);
  }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body ?? null));
}

/**
 * The browser's `window.superHarness`. Native pickers and clipboard reads would open on the
 * server, so the bridge uses browser equivalents for those.
 */
export function bridgeScript(): string {
  return `(() => {
  const INVOKE = ${JSON.stringify(INVOKE_CHANNELS)};
  const EVENTS = ${JSON.stringify(EVENT_CHANNELS)};
  const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
  const enc = (_k, v) => (v instanceof Uint8Array ? { __u8: b64(v) } : v);
  async function call(channel, args) {
    const res = await fetch('rpc/' + encodeURIComponent(channel), {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-superharness': '1' },
      body: JSON.stringify(args, enc),
    });
    const body = await res.json().catch(() => ({ error: 'HTTP ' + res.status }));
    if (!res.ok || body.error) throw new Error(body.error || 'HTTP ' + res.status);
    return body.result;
  }
  const subs = {};
  const es = new EventSource('events');
  es.onmessage = (e) => {
    const m = JSON.parse(e.data);
    for (const cb of (subs[m.channel] || []).slice()) { try { cb(m.payload); } catch (err) { console.error(err); } }
  };
  const readDataUrl = (f) => new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(String(fr.result || '')); fr.onerror = () => r(''); fr.readAsDataURL(f); });
  const api = {};
  for (const [m, ch] of Object.entries(INVOKE)) api[m] = (...args) => call(ch, args);
  for (const [m, ch] of Object.entries(EVENTS)) api[m] = (cb) => { (subs[ch] = subs[ch] || []).push(cb); return () => { subs[ch] = subs[ch].filter((x) => x !== cb); }; };
  api.getPathForFile = () => null;
  api.readClipboardImage = async () => null;
  api.pickDirectory = async () => { const p = window.prompt('Folder path on the server'); return p && p.trim() ? p.trim() : null; };
  api.openExternalUrl = async (url) => { window.open(url, '_blank', 'noopener'); return { ok: true }; };
  api.pickAttachmentFiles = () => new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.oncancel = () => resolve([]);
    input.onchange = async () => {
      const out = [];
      for (const f of Array.from(input.files || [])) {
        let url = await readDataUrl(f);
        if (!url) continue;
        if (url.startsWith('data:;')) url = url.replace('data:;', 'data:application/octet-stream;');
        out.push(await call(INVOKE.saveAttachment, [url, f.name]));
      }
      resolve(out);
    };
    input.click();
  });
  window.superHarness = api;
})();
`;
}
