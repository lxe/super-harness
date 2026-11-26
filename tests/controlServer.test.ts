import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  HarnessCatalog,
  HarnessDetection,
  SuperHarnessState,
  UnifiedSession,
  UsageSnapshot,
} from '../src/shared/types';
import { ControlServer } from '../src/main/services/controlServer';
import type { HarnessRegistry } from '../src/main/adapters/registry';
import type { ConfigStore } from '../src/main/store/configStore';
import type { HarnessDispatcher } from '../src/main/services/dispatcher';

function makeFixtureServer() {
  const sampleHarness: HarnessDetection = {
    id: 'codex',
    name: 'OpenAI Codex',
    installed: true,
    binaryPath: '/usr/bin/codex',
    version: '0.1.0',
    runningProcesses: 1,
    desktopAppRunning: false,
    daemonRunning: true,
    remoteControlEnabled: false,
    activeSessionCount: 1,
    totalSessionCount: 1,
    capabilities: {
      canStartNew: true,
      canResume: true,
      canTmuxMirror: false,
      canControlDaemon: false,
    },
  };

  const sampleSession: UnifiedSession = {
    id: 'codex:t1',
    nativeId: 't1',
    harness: 'codex',
    harnessGroup: 'codex',
    title: 'Mobile API',
    preview: 'Wire up bootstrap endpoint',
    cwd: '/tmp/super-harness',
    projectName: 'super-harness',
    gitBranch: 'main',
    model: 'gpt-5.4',
    status: 'idle',
    isLive: true,
    isRemote: false,
    createdAt: 1000,
    updatedAt: 2000,
    pinned: true,
    pinnedToTop: true,
    folderId: null,
    tags: ['ios'],
    hidden: false,
    dispatchMode: 'codex-resume',
  };

  const state = {
    settings: {
      pollIntervalMs: 5000,
      maxSessionsPerHarness: 80,
      sidebarGroupBy: 'native',
      showArchived: false,
      showHidden: false,
      enabledHarnesses: { codex: true, claude: true, antigravity: true },
      master: { harness: 'claude', model: '', cwd: '/tmp', autoApplyActions: true },
      defaultNewSessionCwd: '/tmp',
      apps: {
        fileClickAction: 'internal',
        folderClickAction: 'file-manager',
        editorCommand: '',
        fileManagerCommand: '',
        terminalCommand: '',
      },
      mobileApi: {
        enabled: true,
        bindHost: '127.0.0.1',
        port: 0,
        token: 'mobile-secret-token',
      },
    },
    folders: [],
    overrides: {},
    masterMessages: [],
  } as SuperHarnessState;

  const store = {
    getState: () => state,
    applyOrganize: vi.fn(() => state),
    updateSettings: vi.fn(() => state),
  } as unknown as ConfigStore;

  const registry = {
    discover: vi.fn(async () => ({
      harnesses: [sampleHarness],
      sessions: [sampleSession],
    })),
    getTranscript: vi.fn(async (sessionId: string) => ({
      sessionId,
      messages: [],
      totalCount: 0,
      hasMore: false,
      sourceMtimeMs: 1234,
    })),
  } as unknown as HarnessRegistry;

  const dispatcher = {
    sendToSession: vi.fn(async () => ({ ok: true, dispatchedVia: 'codex' })),
    abort: vi.fn(() => true),
    startNewSession: vi.fn(async () => ({ ok: true, sessionId: 'codex:new' })),
    archiveSession: vi.fn(async () => ({ ok: true, method: 'native' })),
    controlHarness: vi.fn(async () => ({ ok: true })),
  } as unknown as HarnessDispatcher;

  const usage = {
    codex: {
      harness: 'codex',
      updatedAt: 2000,
      barPercent: 42,
      windows: [],
      spend5hUsd: 0,
      spend24hUsd: 1,
      spend7dUsd: 5,
      spend14dUsd: 9,
      tokens7d: 1000,
      dailySpend7d: [],
      spendIsEstimated: false,
    },
  } as unknown as UsageSnapshot;

  const catalog: HarnessCatalog = {
    models: { codex: [], claude: [], antigravity: [] },
    projects: [{ name: 'super-harness', path: '/tmp/super-harness', harnesses: ['codex'] }],
    updatedAt: 2000,
  };

  const watchSession = vi.fn(async () => {});
  const server = new ControlServer(
    store,
    registry,
    dispatcher,
    async () => {},
    {
      getUsage: vi.fn(async () => usage),
      getCatalog: vi.fn(async () => catalog),
      sendMessage: vi.fn(async () => ({ ok: true, dispatchedVia: 'hook' })),
      abortRun: vi.fn(async () => ({ ok: true })),
      saveAttachment: vi.fn(async (dataUrl, filename) => ({
        id: 'att-1',
        name: filename ?? 'img.png',
        path: '/tmp/img.png',
        mimeType: 'image/png',
        previewDataUrl: dataUrl,
      })),
      watchSession,
    }
  );

  return { server, sampleSession, dispatcher, watchSession };
}

describe('ControlServer mobile API gateway', () => {
  let activeServer: ControlServer | null = null;

  afterEach(() => {
    activeServer?.close();
    activeServer = null;
  });

  it('serves authenticated bootstrap, sessions, usage, catalog, abort, archive, and attachments on mobile listener', async () => {
    const { server, sampleSession, dispatcher } = makeFixtureServer();
    activeServer = server;
    await server.start();
    const mobilePort = await server.syncMobileListener({
      enabled: true,
      bindHost: '127.0.0.1',
      port: 0,
      token: 'test-mobile-token',
    });
    expect(mobilePort).toBeGreaterThan(0);

    const base = `http://127.0.0.1:${mobilePort}`;
    const headers = { Authorization: 'Bearer test-mobile-token' };

    // Rejects missing/wrong token
    const unauth = await fetch(`${base}/api/bootstrap`);
    expect(unauth.status).toBe(401);

    // Bootstrap returns full sessions + usage + catalog
    const bootRes = await fetch(`${base}/api/bootstrap`, { headers });
    expect(bootRes.status).toBe(200);
    const boot = (await bootRes.json()) as {
      sessions: UnifiedSession[];
      usage: UsageSnapshot;
      catalog: HarnessCatalog;
    };
    expect(boot.sessions).toHaveLength(1);
    expect(boot.sessions[0].preview).toBe(sampleSession.preview);
    expect(boot.sessions[0].pinnedToTop).toBe(true);
    expect(boot.usage.codex.barPercent).toBe(42);
    expect(boot.catalog.projects[0].name).toBe('super-harness');

    // Usage & catalog direct endpoints
    expect((await fetch(`${base}/api/usage?force=true`, { headers })).status).toBe(200);
    expect((await fetch(`${base}/api/catalog`, { headers })).status).toBe(200);

    // Abort, archive, and attachment upload
    const abortRes = await fetch(`${base}/api/abort`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'codex:t1' }),
    });
    expect(await abortRes.json()).toEqual({ ok: true });

    const archiveRes = await fetch(`${base}/api/archive`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'codex:t1', killTmux: false }),
    });
    expect(await archiveRes.json()).toEqual({ ok: true, method: 'native' });
    expect(dispatcher.archiveSession).toHaveBeenCalledWith('codex:t1', { killTmux: false });

    const attRes = await fetch(`${base}/api/attachments`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataUrl: 'data:image/png;base64,AAAA', filename: 'snap.png' }),
    });
    const att = (await attRes.json()) as { id: string; name: string; previewDataUrl?: string };
    expect(att.id).toBe('att-1');
    expect(att.name).toBe('snap.png');
    expect(att.previewDataUrl).toBeUndefined();

    // Health + watch + SSE Last-Event-ID replay
    const health = (await (await fetch(`${base}/api/health`, { headers })).json()) as {
      ok: boolean;
      protocolVersion: number;
      seq: number;
    };
    expect(health.ok).toBe(true);
    expect(health.protocolVersion).toBe(2);

    const watchRes = await fetch(`${base}/api/watch`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: 'iphone-1', sessionId: 'codex:t1', limit: 60 }),
    });
    expect(await watchRes.json()).toEqual({
      ok: true,
      paneId: 'mobile:iphone-1',
      sessionId: 'codex:t1',
    });

    server.broadcastEvent('stream', { sessionId: 'codex:t1', runId: 'r1', kind: 'delta', text: 'hi' });
    server.broadcastEvent('stream', { sessionId: 'codex:t1', runId: 'r1', kind: 'done' });

    const ac = new AbortController();
    const sseRes = await fetch(`${base}/api/events?clientId=iphone-1`, {
      headers: { ...headers, 'Last-Event-ID': '1' },
      signal: ac.signal,
    });
    expect(sseRes.status).toBe(200);
    const reader = sseRes.body!.getReader();
    const chunk = new TextDecoder().decode((await reader.read()).value);
    ac.abort();
    expect(chunk).toContain('event: connected');
    expect(chunk).toContain('id: 2');
    expect(chunk).toContain('"kind":"done"');
  });

  it('never floods unwatched SSE clients with transcripts and tail-caps watched transcript pushes to 20 messages', async () => {
    const { server } = makeFixtureServer();
    activeServer = server;
    await server.start();
    const mobilePort = await server.syncMobileListener({
      enabled: true,
      bindHost: '127.0.0.1',
      port: 0,
      token: 'test-mobile-token',
    });
    const base = `http://127.0.0.1:${mobilePort}`;
    const headers = { Authorization: 'Bearer test-mobile-token' };

    // Connect an unwatched client (e.g. sitting on the session list)
    const acUnwatched = new AbortController();
    const unwatchedRes = await fetch(`${base}/api/events?clientId=list-only`, {
      headers,
      signal: acUnwatched.signal,
    });
    const unwatchedReader = unwatchedRes.body!.getReader();
    const firstChunk = new TextDecoder().decode((await unwatchedReader.read()).value);
    expect(firstChunk).toContain('event: connected');

    // Broadcast a huge 50-message transcript while nobody is watching it
    const manyMessages = Array.from({ length: 50 }, (_, i) => ({
      id: `m-${i}`,
      role: 'assistant' as const,
      timestamp: 1000 + i,
      blocks: [{ type: 'text' as const, text: `msg ${i}` }],
    }));
    server.broadcastEvent('transcript', {
      sessionId: 'codex:t1',
      messages: manyMessages,
      totalCount: 50,
      hasMore: false,
      sourceMtimeMs: 1234,
    });

    // Now have a second client watch codex:t1 and verify tail-cap to 20 messages
    await fetch(`${base}/api/watch`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: 'watcher-1', sessionId: 'codex:t1', limit: 20 }),
    });
    const acWatched = new AbortController();
    const watchedRes = await fetch(`${base}/api/events?clientId=watcher-1`, {
      headers,
      signal: acWatched.signal,
    });
    const watchedReader = watchedRes.body!.getReader();
    await watchedReader.read(); // connected

    server.broadcastEvent('transcript', {
      sessionId: 'codex:t1',
      messages: manyMessages,
      totalCount: 50,
      hasMore: false,
      sourceMtimeMs: 1235,
    });
    // Also send a non-scoped event so unwatchedReader resolves cleanly
    server.broadcastEvent('activity', { activeWorkingSessionIds: ['codex:t1'] });

    const watchedFrame = new TextDecoder().decode((await watchedReader.read()).value);
    const unwatchedFrame = new TextDecoder().decode((await unwatchedReader.read()).value);
    acWatched.abort();
    acUnwatched.abort();

    expect(watchedFrame).toContain('event: transcript');
    expect(watchedFrame).toContain('"hasMore":true');
    expect(watchedFrame).toContain('"m-49"');
    expect(watchedFrame).not.toContain('"m-0"');
    expect(unwatchedFrame).toContain('event: activity');
    expect(unwatchedFrame).not.toContain('event: transcript');
  });
});
