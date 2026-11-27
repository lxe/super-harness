import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HarnessGroup, HarnessUpdateJob, SuperHarnessState } from '../src/shared/types';
import { ControlServer } from '../src/main/services/controlServer';
import type { ConfigStore } from '../src/main/store/configStore';
import type { HarnessRegistry } from '../src/main/adapters/registry';
import type { HarnessDispatcher } from '../src/main/services/dispatcher';

const TOKEN = 'phone-token';
const servers: ControlServer[] = [];

function job(harness: HarnessGroup, phase: HarnessUpdateJob['phase']): HarnessUpdateJob {
  return { id: 'j1', harness, phase, startedAt: 1, from: '1.4.0', to: null, log: [] };
}

async function setup() {
  const state = {
    settings: { mobileApi: { enabled: true, bindHost: '127.0.0.1', port: 0, token: TOKEN } },
    folders: [],
    overrides: {},
    masterMessages: [],
  } as unknown as SuperHarnessState;
  const store = { getState: () => structuredClone(state), updateSettings: vi.fn(), subscribe: () => () => {} };
  const started: HarnessGroup[] = [];
  const cancelled: HarnessGroup[] = [];
  const server = new ControlServer(
    store as unknown as ConfigStore,
    {
      getCached: () => ({ harnesses: [], sessions: [] }),
      discover: async () => ({ harnesses: [], sessions: [] }),
      getDriver: (id: string) => (['codex', 'claude', 'antigravity', 'muse', 'pi'].includes(id) ? {} : undefined),
    } as unknown as HarnessRegistry,
    {} as HarnessDispatcher,
    async () => {},
    {
      startHarnessUpdate: (h) => {
        started.push(h);
        return h === 'muse' ? { ok: false, error: 'Muse isn’t installed.' } : { ok: true, job: job(h, 'updating') };
      },
      cancelHarnessUpdate: (h) => {
        cancelled.push(h);
        return true;
      },
      getHarnessUpdateJobs: () => [job('pi', 'done')],
    }
  );
  servers.push(server);
  await server.start();
  const port = await server.syncMobileListener(state.settings.mobileApi);
  const base = `http://127.0.0.1:${port}`;
  const post = (p: string, token = TOKEN) =>
    fetch(`${base}${p}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
  return { server, base, post, started, cancelled };
}

afterEach(() => {
  while (servers.length) servers.pop()!.close();
});

describe('harness update API', () => {
  it('needs the phone token', async () => {
    const { post, started } = await setup();
    expect((await post('/api/harnesses/pi/update', 'wrong')).status).toBe(401);
    expect(started).toEqual([]);
  });

  it('starts an update and returns the job', async () => {
    const { post, started } = await setup();
    const res = await post('/api/harnesses/pi/update');
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ ok: true, job: { harness: 'pi', phase: 'updating' } });
    expect(started).toEqual(['pi']);
  });

  it('reports why an update can’t start', async () => {
    const { post } = await setup();
    const res = await post('/api/harnesses/muse/update');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, error: 'Muse isn’t installed.' });
  });

  it('rejects unknown harnesses', async () => {
    const { post, started } = await setup();
    expect((await post('/api/harnesses/nope/update')).status).toBe(404);
    expect((await post('/api/harnesses/constructor/update')).status).toBe(404);
    expect(started).toEqual([]);
  });

  it('cancels and lists jobs', async () => {
    const { post, base, cancelled } = await setup();
    expect(await (await post('/api/harnesses/codex/update/cancel')).json()).toEqual({ ok: true });
    expect(cancelled).toEqual(['codex']);
    const list = await fetch(`${base}/api/harnesses/updates`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(await list.json()).toMatchObject({ ok: true, jobs: [{ harness: 'pi', phase: 'done' }] });
  });

  it('streams progress to phones as SSE harness_update', async () => {
    const { server, base } = await setup();
    const ac = new AbortController();
    const res = await fetch(`${base}/api/events`, {
      headers: { Authorization: `Bearer ${TOKEN}`, 'Accept-Encoding': 'identity' },
      signal: ac.signal,
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    server.broadcastEvent('harness_update', job('pi', 'restarting'));
    const deadline = Date.now() + 3000;
    while (!text.includes('event: harness_update') && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    ac.abort();
    expect(text).toContain('event: harness_update');
    expect(text).toContain('"phase":"restarting"');
  });
});
