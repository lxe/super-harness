import crypto from 'node:crypto';
import http from 'node:http';
import type {
  HarnessGroup,
  OrganizeAction,
  StartSessionRequest,
  SuperHarnessSettings,
} from '../../shared/types';
import type { HarnessRegistry } from '../adapters/registry';
import type { ConfigStore } from '../store/configStore';
import type { HarnessDispatcher } from './dispatcher';

/**
 * Localhost-only, per-launch token-authenticated HTTP Control Server.
 * Powers the bundled `super-harness-mcp` server so ANY harness powering the
 * Master Session (Claude, Codex, Antigravity) can inspect, organize, configure,
 * and orchestrate Super Harness live.
 */
export class ControlServer {
  private server: http.Server | null = null;
  private sseClients = new Set<http.ServerResponse>();
  public port = 0;
  public readonly token = crypto.randomBytes(24).toString('hex');

  constructor(
    private readonly store: ConfigStore,
    private readonly registry: HarnessRegistry,
    private readonly dispatcher: HarnessDispatcher,
    private readonly triggerRefresh: () => Promise<void>
  ) {}

  broadcastEvent(event: string, data: unknown): void {
    if (this.sseClients.size === 0) return;
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.sseClients) {
      try {
        client.write(payload);
      } catch {
        this.sseClients.delete(client);
      }
    }
  }

  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      const srv = http.createServer(async (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        const auth = req.headers.authorization;
        if (auth !== `Bearer ${this.token}`) {
          res.statusCode = 401;
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }

        const url = new URL(req.url || '/', 'http://127.0.0.1');
        const readBody = async (): Promise<Record<string, unknown>> => {
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          const raw = Buffer.concat(chunks).toString('utf8').trim();
          return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        };

        try {
          if (req.method === 'GET' && url.pathname === '/api/events') {
            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              Connection: 'keep-alive',
            });
            res.write(`event: connected\ndata: {"ok":true}\n\n`);
            this.sseClients.add(res);
            req.on('close', () => {
              this.sseClients.delete(res);
            });
            return;
          }

          if (req.method === 'GET' && url.pathname === '/api/harnesses') {
            const { harnesses } = await this.registry.discover();
            res.end(JSON.stringify({ harnesses }));
            return;
          }

          if (req.method === 'GET' && url.pathname === '/api/sessions') {
            const { sessions } = await this.registry.discover();
            const q = (url.searchParams.get('q') || '').toLowerCase();
            const harness = url.searchParams.get('harness') || '';
            const liveOnly = url.searchParams.get('live') === 'true';
            const filtered = sessions.filter((s) => {
              if (s.harness === 'master') return false;
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
                sessions: filtered.slice(0, 60).map((s) => ({
                  id: s.id,
                  harness: s.harness,
                  title: s.title,
                  projectName: s.projectName,
                  cwd: s.cwd,
                  status: s.status,
                  isLive: s.isLive,
                  isRemote: s.isRemote,
                  tmuxTarget: s.tmuxTarget,
                  folderId: s.folderId,
                  pinned: s.pinned,
                  tags: s.tags,
                  updatedAt: s.updatedAt,
                })),
              })
            );
            return;
          }

          if (req.method === 'GET' && url.pathname === '/api/transcript') {
            const sessionId = url.searchParams.get('sessionId') || '';
            const limit = Number(url.searchParams.get('limit') || '20');
            const tr = await this.registry.getTranscript(sessionId, Math.min(limit, 80));
            res.end(JSON.stringify(tr));
            return;
          }

          if (req.method === 'POST' && url.pathname === '/api/send') {
            const body = await readBody();
            const result = await this.dispatcher.sendToSession(
              String(body.sessionId || ''),
              String(body.message || '')
            );
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
            res.end(JSON.stringify({ ok: true, folders: state.folders }));
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
      });

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

  close(): void {
    this.server?.close();
    this.server = null;
  }
}
