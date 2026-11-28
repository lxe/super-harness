import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebServer, type WebHandler } from '../src/main/services/webServer';
import { INVOKE_CHANNELS } from '../src/shared/ipcChannels';

let server: WebServer | null = null;
afterEach(() => server?.close());

async function start(handlers: Record<string, WebHandler>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-web-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<html><head></head><body>app</body></html>');
  fs.writeFileSync(path.join(os.tmpdir(), 'sh-web-secret.txt'), 'outside');
  server = new WebServer({
    host: '127.0.0.1',
    port: 0,
    token: 'tok-123',
    rendererDir: dir,
    handlers: new Map(Object.entries(handlers)),
    media: () => new Response('m', { status: 200 }),
  });
  await server.start();
  return `http://127.0.0.1:${server.port}`;
}

const cookie = { cookie: 'sh_web=tok-123' };
const rpc = (base: string, channel: string, args: unknown[], headers: Record<string, string> = {}) =>
  fetch(`${base}/rpc/${channel}`, { method: 'POST', headers: { ...cookie, 'x-superharness': '1', ...headers }, body: JSON.stringify(args) });

describe('WebServer', () => {
  it('needs the token, then trades it for a cookie', async () => {
    const base = await start({});
    expect((await fetch(`${base}/`)).status).toBe(401);
    expect((await fetch(`${base}/`, { headers: { cookie: 'sh_web=wrong-1' } })).status).toBe(401);
    const login = await fetch(`${base}/?token=tok-123&x=1`, { redirect: 'manual' });
    expect(login.status).toBe(303);
    expect(login.headers.get('location')).toBe('/?x=1');
    expect(login.headers.get('set-cookie')).toMatch(/sh_web=tok-123; HttpOnly/);
    const page = await (await fetch(`${base}/`, { headers: cookie })).text();
    expect(page).toContain('web-bridge.js');
    expect(page).toContain('__SH_WEB__');
  });

  it('runs IPC handlers over RPC, refuses cross-site posts and unknown channels', async () => {
    const base = await start({ 'sh:send': (id, text) => ({ ok: true, echo: `${id}:${text}` }), 'sh:boom': () => { throw new Error('bad'); } });
    expect(await (await rpc(base, 'sh:send', ['s1', 'hi'])).json()).toEqual({ result: { ok: true, echo: 's1:hi' } });
    expect((await rpc(base, 'sh:send', [], { 'x-superharness': '0' })).status).toBe(403);
    expect((await rpc(base, 'sh:nope', [])).status).toBe(404);
    expect(await (await rpc(base, 'sh:boom', [])).json()).toEqual({ error: 'bad' });
  });

  it('does not serve files outside the renderer folder', async () => {
    const base = await start({});
    const res = await fetch(`${base}/..%2Fsh-web-secret.txt`, { headers: cookie });
    expect(res.status).toBe(404);
  });

  it('streams broadcasts to connected browsers', async () => {
    const base = await start({});
    const res = await fetch(`${base}/events`, { headers: cookie });
    const reader = res.body!.getReader();
    await reader.read(); // ": connected"
    server!.broadcast('sh:state-changed', { n: 1 });
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toContain('{"channel":"sh:state-changed","payload":{"n":1}}');
    await reader.cancel();
  });

  it('bridge exposes every invoke channel', async () => {
    const base = await start({});
    const js = await (await fetch(`${base}/web-bridge.js`, { headers: cookie })).text();
    for (const ch of Object.values(INVOKE_CHANNELS)) expect(js).toContain(`"${ch}"`);
  });
});
