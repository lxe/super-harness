import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SuperHarnessSettings, SuperHarnessState } from '../src/shared/types';
import { ControlServer } from '../src/main/services/controlServer';
import {
  hashToken,
  PAIRING_CODE_TTL_MS,
  PAIRING_RATE_LIMIT,
  PairingService,
  type PairingEvent,
} from '../src/main/services/pairing';
import { deriveRelayCredentials, PushNotifier } from '../src/main/services/pushNotifier';
import type { ConfigStore } from '../src/main/store/configStore';
import type { HarnessRegistry } from '../src/main/adapters/registry';
import type { HarnessDispatcher } from '../src/main/services/dispatcher';

const LEGACY = 'legacy-phone-token';

function makeStore() {
  const state = {
    settings: {
      mobileApi: { enabled: true, bindHost: '127.0.0.1', port: 0, token: LEGACY },
    },
    folders: [],
    overrides: {},
    masterMessages: [],
  } as unknown as SuperHarnessState;
  const store = {
    getState: () => structuredClone(state),
    updateSettings: vi.fn((patch: Partial<SuperHarnessSettings>) => {
      state.settings = {
        ...state.settings,
        ...patch,
        mobileApi: { ...state.settings.mobileApi!, ...(patch.mobileApi ?? {}) },
      };
      return structuredClone(state);
    }),
    subscribe: () => () => {},
  };
  return { state, store };
}

let clock = 1_000_000;
const servers: ControlServer[] = [];

async function setup(opts: { push?: PushNotifier } = {}) {
  const { state, store } = makeStore();
  const events: PairingEvent[] = [];
  let server: ControlServer;
  const pairing = new PairingService(store, {
    now: () => clock,
    hostName: () => 'test-desktop',
    version: '9.9.9',
    onEvent: (e) => events.push(e),
    onRevoke: (id) => {
      server.dropDeviceConnections(id);
      opts.push?.removePairedDevice(id);
    },
  });
  server = new ControlServer(
    store as unknown as ConfigStore,
    {
      getCached: () => ({ harnesses: [], sessions: [] }),
      discover: async () => ({ harnesses: [], sessions: [] }),
    } as unknown as HarnessRegistry,
    {} as HarnessDispatcher,
    async () => {},
    {
      pairing,
      ...(opts.push ? { registerPushDevice: (o) => opts.push!.registerDevice(o) } : {}),
    }
  );
  servers.push(server);
  await server.start();
  const port = await server.syncMobileListener(state.settings.mobileApi);
  const base = `http://127.0.0.1:${port}`;
  const pair = (body: Record<string, unknown>) =>
    fetch(`${base}/api/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const authed = (token: string, p = '/api/health') =>
    fetch(`${base}${p}`, { headers: { Authorization: `Bearer ${token}` } });
  return { state, store, pairing, server, base, events, pair, authed };
}

afterEach(() => {
  while (servers.length) servers.pop()!.close();
  clock += PAIRING_RATE_LIMIT.windowMs * 2; // fresh rate-limit window per test
});

describe('pairing API', () => {
  it('serves /api/pair/info without auth and with nothing secret in it', async () => {
    const { base, pairing, state } = await setup();
    const res = await fetch(`${base}/api/pair/info`);
    expect(res.status).toBe(200);
    const info = await res.json();
    expect(info).toMatchObject({ ok: true, hostName: 'test-desktop', version: '9.9.9', pairingOpen: false });
    expect(info.hostId).toMatch(/^[0-9a-f]{16}$/);
    // The host id is stable: saved in settings and reused.
    expect(state.settings.mobileApi?.hostId).toBe(info.hostId);
    expect((await (await fetch(`${base}/api/pair/info`)).json()).hostId).toBe(info.hostId);
    expect(JSON.stringify(info)).not.toContain(LEGACY);
    pairing.open();
    expect((await (await fetch(`${base}/api/pair/info`)).json()).pairingOpen).toBe(true);
  });

  it('pairs with the right code, stores only a hash, and the new token authenticates', async () => {
    const { pair, pairing, state, authed, events } = await setup();
    const { code } = pairing.open();
    const res = await pair({ code, deviceName: 'lxe iPhone', deviceId: 'dev-1' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, hostName: 'test-desktop' });
    expect(body.token).toMatch(/^[0-9a-f]{64}$/);
    expect(body.hostId).toBe(state.settings.mobileApi?.hostId);

    const devices = state.settings.mobileApi?.pairedDevices ?? [];
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({ id: 'dev-1', name: 'lxe iPhone', tokenHash: hashToken(body.token) });
    expect(JSON.stringify(state)).not.toContain(body.token);

    expect((await authed(body.token)).status).toBe(200);
    expect(events).toContainEqual({ type: 'paired', device: { id: 'dev-1', name: 'lxe iPhone' } });
    expect(pairing.pairingOpen()).toBe(false);
  });

  it('accepts the legacy token alongside device tokens and rejects anything else', async () => {
    const { authed, base } = await setup();
    expect((await authed(LEGACY)).status).toBe(200);
    expect((await authed('nope')).status).toBe(401);
    expect((await fetch(`${base}/api/health`)).status).toBe(401);
  });

  it('makes the code one-time', async () => {
    const { pair, pairing } = await setup();
    const { code } = pairing.open();
    expect((await pair({ code, deviceName: 'a', deviceId: 'a' })).status).toBe(200);
    const again = await pair({ code, deviceName: 'b', deviceId: 'b' });
    expect(again.status).toBe(401);
  });

  it('rejects a code after 10 minutes', async () => {
    const { pair, pairing, events } = await setup();
    const { code, expiresAt } = pairing.open();
    expect(expiresAt - clock).toBe(PAIRING_CODE_TTL_MS);
    clock += PAIRING_CODE_TTL_MS;
    const res = await pair({ code, deviceName: 'a', deviceId: 'a' });
    expect(res.status).toBe(401);
    expect(events).toContainEqual({ type: 'closed', reason: 'expired' });
  });

  it('invalidates the code after 5 wrong attempts', async () => {
    const { pair, pairing, events } = await setup();
    const { code } = pairing.open();
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 4; i++) {
      const r = await pair({ code: wrong, deviceName: 'x', deviceId: 'x' });
      expect(r.status).toBe(401);
      expect(pairing.pairingOpen()).toBe(true);
    }
    expect((await pair({ code: wrong, deviceName: 'x', deviceId: 'x' })).status).toBe(401);
    expect(pairing.pairingOpen()).toBe(false);
    expect(events).toContainEqual({ type: 'closed', reason: 'too_many_attempts' });
    // Even the right code no longer works.
    expect((await pair({ code, deviceName: 'x', deviceId: 'x' })).status).toBe(401);
  });

  it('rate-limits POST /api/pair per address with 429', async () => {
    const { pair } = await setup();
    const statuses: number[] = [];
    for (let i = 0; i < PAIRING_RATE_LIMIT.max + 1; i++) {
      statuses.push((await pair({ code: '123456', deviceName: 'x', deviceId: 'x' })).status);
    }
    expect(statuses.slice(0, PAIRING_RATE_LIMIT.max).every((s) => s === 401)).toBe(true);
    expect(statuses[PAIRING_RATE_LIMIT.max]).toBe(429);
  });

  it('rejects malformed bodies', async () => {
    const { pair, pairing } = await setup();
    pairing.open();
    expect((await pair({ code: '12', deviceName: 'x', deviceId: 'x' })).status).toBe(400);
    expect((await pair({ code: '123456', deviceName: 'x' })).status).toBe(400);
  });

  it('revoking a device returns 401 to its next request and closes its open event stream', async () => {
    const { pair, pairing, authed, state, base } = await setup();
    const { code } = pairing.open();
    const { token } = await (await pair({ code, deviceName: 'p', deviceId: 'dev-2' })).json();
    expect((await authed(token)).status).toBe(200);

    // Open an SSE stream with the device token.
    const streamClosed = new Promise<void>((resolve) => {
      const req = http.get(
        `${base}/api/events`,
        { headers: { Authorization: `Bearer ${token}` }, agent: false },
        (res) => {
          res.on('data', () => {});
          res.on('close', () => resolve());
          res.on('error', () => resolve());
          setTimeout(() => pairing.revoke('dev-2'), 100);
        }
      );
      req.on('error', () => resolve());
    });
    await streamClosed;

    expect(state.settings.mobileApi?.pairedDevices).toEqual([]);
    expect((await authed(token)).status).toBe(401);
    expect((await authed(LEGACY)).status).toBe(200);
  });

  it('re-pairing the same device replaces its old token', async () => {
    const { pair, pairing, authed, state } = await setup();
    const first = await (await pair({ code: pairing.open().code, deviceName: 'p', deviceId: 'same' })).json();
    const second = await (await pair({ code: pairing.open().code, deviceName: 'p2', deviceId: 'same' })).json();
    expect(state.settings.mobileApi?.pairedDevices).toHaveLength(1);
    expect((await authed(first.token)).status).toBe(401);
    expect((await authed(second.token)).status).toBe(200);
  });

  it('updates lastSeenAt at most every two minutes', async () => {
    const { pair, pairing, authed, state } = await setup();
    const { token } = await (await pair({ code: pairing.open().code, deviceName: 'p', deviceId: 'seen' })).json();
    const t0 = state.settings.mobileApi!.pairedDevices![0].lastSeenAt!;
    clock += 30_000;
    await authed(token);
    expect(state.settings.mobileApi!.pairedDevices![0].lastSeenAt).toBe(t0);
    clock += 120_000;
    await authed(token);
    expect(state.settings.mobileApi!.pairedDevices![0].lastSeenAt).toBe(clock);
  });

  it('keeps tokens and token hashes out of the state sent to phones', async () => {
    const { pair, pairing, authed } = await setup();
    const { token } = await (await pair({ code: pairing.open().code, deviceName: 'p', deviceId: 'r' })).json();
    const boot = await (await authed(token, '/api/bootstrap')).text();
    expect(boot).not.toContain(LEGACY);
    expect(boot).not.toContain(hashToken(token));
    expect(boot).not.toContain(token);
    expect(boot).toContain('"pairedDevices"');
  });

  it('POST /api/unpair revokes the calling device; with the legacy token it is a no-op', async () => {
    const { pair, pairing, authed, state, base } = await setup();
    const { token } = await (await pair({ code: pairing.open().code, deviceName: 'p', deviceId: 'self' })).json();
    const unpair = (t: string) =>
      fetch(`${base}/api/unpair`, { method: 'POST', headers: { Authorization: `Bearer ${t}` } });

    const legacy = await unpair(LEGACY);
    expect(legacy.status).toBe(200);
    expect(await legacy.json()).toEqual({ ok: true });
    expect(state.settings.mobileApi?.pairedDevices).toHaveLength(1);

    const res = await unpair(token);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(state.settings.mobileApi?.pairedDevices).toEqual([]);
    expect((await authed(token)).status).toBe(401);
    expect((await unpair(token)).status).toBe(401);
    expect((await authed(LEGACY)).status).toBe(200);
  });

  it('uses the desktop name from settings when set', async () => {
    const { base, store } = await setup();
    store.updateSettings({ mobileApi: { hostName: 'Studio PC' } } as Partial<SuperHarnessSettings>);
    expect((await (await fetch(`${base}/api/pair/info`)).json()).hostName).toBe('Studio PC');
  });

  it('does not serve pairing routes on the loopback MCP listener', async () => {
    const { server } = await setup();
    const res = await fetch(`http://127.0.0.1:${server.port}/api/pair/info`);
    expect(res.status).toBe(401);
  });
});

describe('push relay keys for paired devices', () => {
  it('derives the relay key from the token the phone registered with and drops it on revoke', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-push-'));
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const push = new PushNotifier(() => LEGACY);
      const { pair, pairing, base } = await setup({ push });
      const { token } = await (await pair({ code: pairing.open().code, deviceName: 'p', deviceId: 'push-dev' })).json();
      const rid = deriveRelayCredentials(token).rid;
      const res = await fetch(`${base}/api/push/register`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ rid, relayUrl: 'http://127.0.0.1:1' }),
      });
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(JSON.stringify(body)).not.toContain(deriveRelayCredentials(token).key.toString('hex'));
      const saved = JSON.parse(fs.readFileSync(path.join(home, '.config', 'super-harness', 'push-devices.json'), 'utf8'));
      expect(saved[0]).toMatchObject({
        rid,
        pairedDeviceId: 'push-dev',
        keyHex: deriveRelayCredentials(token).key.toString('hex'),
      });

      pairing.revoke('push-dev');
      expect(push.getRegisteredDevices()).toEqual([]);
    } finally {
      process.env.HOME = prevHome;
    }
  });
});

describe('ConfigStore pairing persistence across settings updates and restarts', () => {
  it('preserves pairedDevices, hostId, and hostName when unrelated settings are updated and across reload', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-pair-persist-'));
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    try {
      vi.resetModules();
      const { ConfigStore } = await import('../src/main/store/configStore');
      const store1 = new ConfigStore();
      const pairing1 = new PairingService(store1);
      const { code } = pairing1.open();
      const paired = pairing1.attempt({ code, deviceName: 'iPhone', deviceId: 'dev-persist-1' }, '10.0.0.5');
      expect(paired.status).toBe(200);
      if (paired.status !== 200) throw new Error('expected 200');
      const { token, hostId } = paired.body;

      // Updating unrelated settings must never drop pairedDevices, hostId, or hostName
      store1.updateSettings({ mobileApi: { ...store1.getState().settings.mobileApi!, hostName: 'Workstation' } });
      store1.updateSettings({ sidebarGroupBy: 'folders' });
      store1.updateSettings({ pinnedOrder: ['claude:abc'] });

      const afterUpdates = store1.getState().settings.mobileApi!;
      expect(afterUpdates.hostId).toBe(hostId);
      expect(afterUpdates.hostName).toBe('Workstation');
      expect(afterUpdates.pairedDevices).toHaveLength(1);
      expect(afterUpdates.pairedDevices?.[0].id).toBe('dev-persist-1');
      expect(afterUpdates.pairedDevices?.[0].tokenHash).toBe(hashToken(token));

      // Simulated restart: fresh ConfigStore + PairingService reading from state.json
      const store2 = new ConfigStore();
      const pairing2 = new PairingService(store2);
      expect(pairing2.hostId()).toBe(hostId);
      expect(pairing2.hostName).toBe('Workstation');
      expect(pairing2.authenticate(token)).toEqual({ kind: 'device', deviceId: 'dev-persist-1' });
    } finally {
      process.env.HOME = prevHome;
      vi.resetModules();
    }
  });

  it('deduplicates push registrations for the same pairedDeviceId on register and on load', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-push-dedupe-'));
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const push = new PushNotifier(() => LEGACY);
      push.registerDevice({ authToken: 'token-old', pairedDeviceId: 'phone-1', relayUrl: 'http://127.0.0.1:1' });
      push.registerDevice({ authToken: 'token-new', pairedDeviceId: 'phone-1', relayUrl: 'http://127.0.0.1:1' });
      expect(push.getRegisteredDevices()).toHaveLength(1);
      expect(push.getRegisteredDevices()[0].rid).toBe(deriveRelayCredentials('token-new').rid);

      // Simulate legacy file with multiple stale entries for the same pairedDeviceId
      const file = path.join(home, '.config', 'super-harness', 'push-devices.json');
      fs.writeFileSync(
        file,
        JSON.stringify([
          { rid: 'older-rid', relayUrl: 'http://127.0.0.1:1', enabled: true, updatedAt: 100, pairedDeviceId: 'phone-1' },
          { rid: 'newer-rid', relayUrl: 'http://127.0.0.1:1', enabled: true, updatedAt: 200, pairedDeviceId: 'phone-1' },
        ])
      );
      const reloaded = new PushNotifier(() => LEGACY);
      expect(reloaded.getRegisteredDevices().map((d) => d.rid)).toEqual(['newer-rid']);
    } finally {
      process.env.HOME = prevHome;
    }
  });
});
