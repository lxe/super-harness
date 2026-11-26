import { app, BrowserWindow, clipboard, dialog, ipcMain, net, protocol, shell } from 'electron';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import type {
  HarnessGroup,
  ImageAttachment,
  OrganizeAction,
  StartSessionRequest,
  StreamEvent,
  SuperHarnessSettings,
} from '../shared/types';
import { HarnessRegistry } from './adapters/registry';
import { createProjectDirectory, HarnessCatalogService } from './services/catalogService';
import { ControlServer } from './services/controlServer';
import { HarnessDispatcher } from './services/dispatcher';
import { LiveSyncService } from './services/liveSync';
import { MasterEngine } from './services/masterEngine';
import {
  detectSystemApps,
  openPathWithApp,
  readFilePreview,
} from './services/systemLauncher';
import { UsageService } from './services/usageService';
import { ConfigStore } from './store/configStore';
import { closeSqlitePool } from './utils/sqlite';
import { whichBinary } from './utils/system';

// Expose our Electron PID to child agent processes (Codex, Claude, Antigravity, Muse)
// so running `scripts/launch-electron.mjs` or `npm run restart` from inside a session
// automatically delegates to the detached restart watchdog instead of dying mid-shutdown.
process.env.SUPER_HARNESS_APP_PID = String(process.pid);

let mainWindow: BrowserWindow | null = null;
let pollTimer: NodeJS.Timeout | null = null;
let usageTimer: NodeJS.Timeout | null = null;
let restartInProgress = false;

async function scheduleDetachedRestart(opts?: {
  build?: boolean;
}): Promise<{ ok: boolean; error?: string }> {
  if (restartInProgress) {
    return { ok: true };
  }
  const repoRoot = path.resolve(__dirname, '../../..');
  const restartScript = path.join(repoRoot, 'scripts', 'restart-electron.mjs');
  if (!fs.existsSync(restartScript)) {
    return { ok: false, error: `Restart helper not found at ${restartScript}` };
  }

  restartInProgress = true;
  try {
    const nodeBin = await whichBinary('node');
    const runnerBin = nodeBin || process.execPath;
    const workerEnv: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: 'production',
      SUPER_HARNESS_ELECTRON_BIN: process.execPath,
    };
    if (!nodeBin) {
      workerEnv.ELECTRON_RUN_AS_NODE = '1';
    } else {
      delete workerEnv.ELECTRON_RUN_AS_NODE;
    }

    const args = [restartScript, '--worker', `--wait-pid=${process.pid}`];
    if (opts?.build) args.push('--build');

    const worker = spawn(runnerBin, args, {
      cwd: repoRoot,
      env: workerEnv,
      detached: true,
      stdio: 'ignore',
    });
    worker.unref();

    // If not rebuilding first, quit cleanly after the IPC/HTTP reply flushes;
    // when rebuilding, the detached worker keeps the app alive until `npm run build` succeeds.
    if (!opts?.build) {
      setTimeout(() => {
        app.quit();
      }, 150);
    }
    return { ok: true };
  } catch (err) {
    restartInProgress = false;
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'sh-media',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
]);

function injectEmbedPreviewRuntime(html: string, token: string): string {
  const safeToken = JSON.stringify(token);
  const headInjection = `<style data-sh-embed-theme>
:root {
  color-scheme: dark;
  --background: #16171b;
  --content: #16171b;
  --card: #1d1f25;
  --sidebar: #131418;
  --card-border: rgba(255, 255, 255, 0.09);
  --border: rgba(255, 255, 255, 0.11);
  --foreground: #f4f4f5;
  --muted-foreground: #a1a1aa;
  --placeholder: #71717a;
  --code-foreground: #e4e4e7;
  --primary: #3b82f6;
  --primary-foreground: #ffffff;
  --secondary: #27272a;
  --secondary-foreground: #f4f4f5;
  --accent: #27272a;
  --link: #60a5fa;
  --success: #34d399;
  --warning: #fbbf24;
  --error: #f87171;
  --chart-1: #60a5fa;
  --chart-2: #34d399;
  --chart-3: #c084fc;
  --chart-4: #fbbf24;
  --chart-5: #f87171;
  --chart-6: #22d3ee;
}
html, body {
  margin: 0;
  padding: 0;
  background: transparent;
  color: var(--foreground);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, sans-serif;
  font-size: 14px;
  overflow-x: hidden;
}
</style>
<script data-sh-embed-bridge>
(function () {
  var TOKEN = ${safeToken};
  var lastHeight = 0;
  function measureContentHeight() {
    try {
      var body = document.body;
      if (!body) return 0;
      var maxBottom = 0;
      var children = body.children;
      for (var i = 0; i < children.length; i++) {
        var el = children[i];
        if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE') continue;
        var rect = el.getBoundingClientRect();
        if (rect.bottom > maxBottom) maxBottom = rect.bottom;
      }
      var h = Math.ceil(maxBottom > 0 ? maxBottom : body.offsetHeight || 0);
      return h;
    } catch (e) {
      return 0;
    }
  }
  function reportHeight() {
    var h = measureContentHeight();
    if (h > 0 && Math.abs(h - lastHeight) > 2) {
      lastHeight = h;
      window.parent.postMessage({ type: 'sh-embed-resize', token: TOKEN, height: h }, '*');
    }
  }
  try {
    var origClip = navigator.clipboard && navigator.clipboard.writeText
      ? navigator.clipboard.writeText.bind(navigator.clipboard)
      : null;
    var proxyWrite = function (text) {
      window.parent.postMessage({ type: 'sh-embed-copy', token: TOKEN, text: String(text || '') }, '*');
      return origClip ? origClip(text).catch(function () {}) : Promise.resolve();
    };
    if (navigator.clipboard) {
      try { navigator.clipboard.writeText = proxyWrite; } catch (e) {}
    } else {
      try { Object.defineProperty(navigator, 'clipboard', { value: { writeText: proxyWrite } }); } catch (e) {}
    }
  } catch (e) {}
  window.addEventListener('load', function () {
    reportHeight();
    setTimeout(reportHeight, 150);
    setTimeout(reportHeight, 600);
    if (typeof ResizeObserver !== 'undefined' && document.body && document.body.firstElementChild) {
      new ResizeObserver(reportHeight).observe(document.body.firstElementChild);
    }
  });
  document.addEventListener('DOMContentLoaded', reportHeight);
})();
</script>`;

  if (/<head\b[^>]*>/i.test(html)) {
    return html.replace(/<head\b[^>]*>/i, (m) => `${m}\n${headInjection}`);
  }
  return `${headInjection}\n${html}`;
}

const store = new ConfigStore();
const registry = new HarnessRegistry(store);
const usageService = new UsageService();
const catalogService = new HarnessCatalogService();

function broadcastToRenderer(channel: string, payload: unknown): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const wc = mainWindow.webContents;
  if (!wc || wc.isDestroyed() || wc.isCrashed()) return;
  try {
    wc.send(channel, payload);
  } catch {
    // Ignore transient disposal races if the renderer frame is unloading or restarting
  }
}

function saveDataUrlAttachment(dataUrl: string, filename?: string): ImageAttachment {
  const attachDir = path.join(os.homedir(), '.config', 'super-harness', 'attachments');
  fs.mkdirSync(attachDir, { recursive: true });
  const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  const mimeType = match?.[1] || 'image/png';
  const base64 = match?.[2] || '';
  const extMap: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
  };
  const ext = extMap[mimeType] || 'png';
  const id = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const safeName = (filename || `pasted-${id}.${ext}`).replace(/[^a-zA-Z0-9._-]/g, '_');
  const filePath = path.join(attachDir, `${id}-${safeName}`);
  fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
  return {
    id,
    name: safeName,
    path: filePath,
    mimeType,
    previewDataUrl: dataUrl,
  };
}

let controlServerRef: ControlServer | null = null;
let masterEngineRef: MasterEngine | null = null;
let liveSyncRef: LiveSyncService | null = null;

const activeStreamingSessionIds = new Set<string>();
const liveWorkingSessionIds = new Set<string>();
let lastBroadcastWorkingKey = '';

function getActiveWorkingSessionIds(): string[] {
  const merged = new Set<string>([...activeStreamingSessionIds, ...liveWorkingSessionIds]);
  for (const s of registry.getCached().sessions) {
    if (!s.id.startsWith('master:') && s.status === 'running') {
      merged.add(s.id);
    }
  }
  return Array.from(merged).sort();
}

function broadcastActivityIfChanged(): void {
  const workingSessionIds = getActiveWorkingSessionIds();
  const key = workingSessionIds.join(',');
  if (key === lastBroadcastWorkingKey) return;
  lastBroadcastWorkingKey = key;
  controlServerRef?.broadcastEvent('activity', { workingSessionIds });
}

const emitStream = (ev: StreamEvent) => {
  if (ev.kind === 'start' || ev.kind === 'delta' || ev.kind === 'block') {
    activeStreamingSessionIds.add(ev.sessionId);
  } else if (ev.kind === 'done' || ev.kind === 'error') {
    activeStreamingSessionIds.delete(ev.sessionId);
  }
  broadcastToRenderer('sh:stream', ev);
  controlServerRef?.broadcastEvent('stream', ev);
  broadcastActivityIfChanged();
};

let refreshInFlight: Promise<{
  harnesses: Awaited<ReturnType<HarnessRegistry['discover']>>['harnesses'];
  sessions: Awaited<ReturnType<HarnessRegistry['discover']>>['sessions'];
}> | null = null;

async function refreshAndBroadcast() {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = registry
    .discover()
    .then((result) => {
      const activeSet = new Set<string>([...activeStreamingSessionIds, ...liveWorkingSessionIds]);
      const sessions = result.sessions.map((s) =>
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
      const decorated = { ...result, sessions };
      broadcastToRenderer('sh:sessions-updated', decorated);
      controlServerRef?.broadcastEvent('sessions', { ...decorated, activeWorkingSessionIds });
      lastBroadcastWorkingKey = activeWorkingSessionIds.join(',');
      return decorated;
    })
    .finally(() => {
      refreshInFlight = null;
    });
  return refreshInFlight;
}

const dispatcher = new HarnessDispatcher(registry, store, emitStream, () => {
  void refreshAndBroadcast();
});

const controlServer = new ControlServer(
  store,
  registry,
  dispatcher,
  async () => {
    await refreshAndBroadcast();
  },
  {
    getUsage: async (force) => usageService.getUsage(force),
    getCatalog: async (force) => {
      let { sessions } = registry.getCached();
      if (sessions.length === 0) {
        sessions = (await registry.discover()).sessions;
      }
      return catalogService.getCatalog(sessions, force);
    },
    sendMessage: async (sessionId, prompt, attachments, opts) => {
      if (sessionId === 'master:root' && masterEngineRef) {
        return masterEngineRef.handlePrompt(prompt, attachments);
      }
      return dispatcher.sendToSession(sessionId, prompt, attachments, opts);
    },
    onMessageSent: (sessionId) => {
      if (!sessionId.startsWith('master:')) {
        liveWorkingSessionIds.add(sessionId);
        broadcastActivityIfChanged();
      }
      if (liveSyncRef) {
        setTimeout(() => liveSyncRef?.notifyExternalActivity(sessionId), 400);
        setTimeout(() => liveSyncRef?.notifyExternalActivity(sessionId), 1500);
      }
    },
    abortRun: async (sessionId) => {
      if (sessionId === 'master:root' && masterEngineRef) {
        return { ok: masterEngineRef.abort() };
      }
      return { ok: dispatcher.abort(sessionId) };
    },
    saveAttachment: async (dataUrl, filename) => saveDataUrlAttachment(dataUrl, filename),
    readFilePreview: async (filePath, startLine, endLine) =>
      readFilePreview(filePath, startLine, endLine),
    watchSession: async (paneId, sessionId, limit) => {
      if (liveSyncRef) {
        await liveSyncRef.watchPane(paneId, sessionId, limit ?? 80);
      }
    },
    getActiveWorkingSessionIds: () => getActiveWorkingSessionIds(),
    restartApp: async (opts) => scheduleDetachedRestart(opts),
  }
);
controlServerRef = controlServer;

const liveSync = new LiveSyncService(
  registry,
  () => {
    void refreshAndBroadcast();
  },
  (transcript) => {
    if (typeof transcript.liveActivity?.isWorking === 'boolean') {
      if (transcript.liveActivity.isWorking) {
        liveWorkingSessionIds.add(transcript.sessionId);
      } else {
        liveWorkingSessionIds.delete(transcript.sessionId);
      }
      broadcastActivityIfChanged();
    }
    broadcastToRenderer('sh:transcript-updated', transcript);
    controlServer.broadcastEvent('transcript', transcript);
    controlServer.broadcastEvent('transcript_updated', {
      sessionId: transcript.sessionId,
      totalCount: transcript.totalCount,
      liveActivity: transcript.liveActivity,
    });
  }
);
liveSyncRef = liveSync;
for (const driver of registry.getDrivers()) {
  driver.setActivitySink?.((sessionId) => liveSync.notifyExternalActivity(sessionId));
}

const masterEngine = new MasterEngine(
  store,
  registry,
  dispatcher,
  controlServer,
  emitStream,
  async () => {
    await refreshAndBroadcast();
  }
);
masterEngineRef = masterEngine;

store.subscribe((state) => {
  broadcastToRenderer('sh:state-changed', state);
  controlServer.broadcastEvent('state', state);
  schedulePolling(state.settings.pollIntervalMs);
  void controlServer.syncMobileListener(state.settings.mobileApi);
});

function schedulePolling(intervalMs: number): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (intervalMs === 0) return;
  const safeMs = Math.max(1000, Math.min(intervalMs || 5000, 60000));
  pollTimer = setInterval(() => {
    void refreshAndBroadcast();
  }, safeMs);
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 980,
    minHeight: 640,
    title: 'Super Harness',
    backgroundColor: '#16171b',
    titleBarStyle: 'hidden',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // Auto-recover if the Chromium renderer process ever crashes (e.g. GPU reset or memory spike)
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit') return;
    console.error(`[super-harness] renderer process gone (${details.reason}); reloading window`);
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        const devUrl = process.env.VITE_DEV_SERVER_URL;
        if (devUrl) {
          void mainWindow.loadURL(devUrl);
        } else {
          void mainWindow.loadFile(
            path.resolve(__dirname, '../../../dist/renderer/index.html')
          );
        }
      }
    }, 300);
  });

  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level >= 3) {
      console.error(`[renderer-error] ${message} (${sourceId}:${line})`);
    }
  });

  // Never allow clicking file:// or http(s):// links inside markdown to hijack the Electron window!
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env.VITE_DEV_SERVER_URL;
    if (devUrl && url.startsWith(devUrl)) return;
    if (url.includes('/dist/renderer/index.html')) return;
    event.preventDefault();
    if (url.startsWith('http://') || url.startsWith('https://')) {
      void shell.openExternal(url);
    }
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    void mainWindow.loadURL(devUrl);
  } else {
    const indexHtml = path.resolve(__dirname, '../../../dist/renderer/index.html');
    void mainWindow.loadFile(indexHtml);
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function registerIpcHandlers(): void {
  ipcMain.handle('sh:bootstrap', async () => {
    const { harnesses, sessions } = await registry.discover();
    // Warm model/project catalog in the background so New Conversation opens instantaneously
    void catalogService.getCatalog(sessions);
    return {
      harnesses,
      sessions,
      state: store.getState(),
      controlPort: controlServer.port,
    };
  });

  ipcMain.handle('sh:catalog', async (_ev, force?: boolean) => {
    let { sessions } = registry.getCached();
    if (sessions.length === 0) {
      sessions = (await registry.discover()).sessions;
    }
    return catalogService.getCatalog(sessions, Boolean(force));
  });

  ipcMain.handle('sh:create-project', async (_ev, parentDir: string, name: string) => {
    const res = createProjectDirectory(parentDir, name);
    if (res.ok) catalogService.invalidate();
    return res;
  });

  ipcMain.handle('sh:refresh', async () => {
    return refreshAndBroadcast();
  });

  ipcMain.handle('sh:transcript', async (_ev, sessionId: string, limit?: number) => {
    return registry.getTranscript(sessionId, limit ?? 120);
  });

  ipcMain.handle(
    'sh:watch-session',
    async (_ev, paneId: string, sessionId: string | null, limit?: number) => {
      await liveSync.watchPane(paneId, sessionId, limit ?? 60);
      return { ok: true };
    }
  );

  ipcMain.handle('sh:capture-tmux', async (_ev, target: string) => {
    return registry.captureTmux(target);
  });

  ipcMain.handle(
    'sh:save-attachment',
    async (_ev, dataUrl: string, filename?: string): Promise<ImageAttachment> => {
      return saveDataUrlAttachment(dataUrl, filename);
    }
  );

  ipcMain.handle('sh:read-clipboard-image', async (): Promise<ImageAttachment | null> => {
    try {
      const img = clipboard.readImage();
      if (!img.isEmpty()) {
        const png = img.toPNG();
        if (png.length > 0) {
          const dataUrl = `data:image/png;base64,${png.toString('base64')}`;
          return saveDataUrlAttachment(dataUrl, `clipboard-${Date.now()}.png`);
        }
      }
    } catch {
      // ignore clipboard read errors
    }
    return null;
  });

  ipcMain.handle('sh:pick-image-files', async (): Promise<ImageAttachment[]> => {
    if (!mainWindow) return [];
    const res = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
    });
    if (res.canceled) return [];
    const out: ImageAttachment[] = [];
    for (const fp of res.filePaths) {
      try {
        const ext = path.extname(fp).toLowerCase().slice(1);
        const mimeType = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext || 'png'}`;
        const buf = fs.readFileSync(fp);
        out.push({
          id: crypto.randomBytes(6).toString('hex'),
          name: path.basename(fp),
          path: fp,
          mimeType,
          previewDataUrl: `data:${mimeType};base64,${buf.toString('base64')}`,
        });
      } catch {
        // ignore unreadable image
      }
    }
    return out;
  });

  ipcMain.handle(
    'sh:send',
    async (
      _ev,
      sessionId: string,
      prompt: string,
      attachments?: ImageAttachment[],
      opts?: { force?: boolean }
    ) => {
      if (sessionId === 'master:root') {
        return masterEngine.handlePrompt(prompt, attachments);
      }
      return dispatcher.sendToSession(sessionId, prompt, attachments, opts);
    }
  );

  ipcMain.handle(
    'sh:queue-message',
    async (_ev, sessionId: string, prompt: string, attachments?: ImageAttachment[]) => {
      return dispatcher.queueToSession(sessionId, prompt, attachments);
    }
  );

  ipcMain.handle('sh:abort', async (_ev, sessionId: string) => {
    if (sessionId === 'master:root') {
      return { ok: masterEngine.abort() };
    }
    return { ok: dispatcher.abort(sessionId) };
  });

  ipcMain.handle('sh:start-session', async (_ev, req: StartSessionRequest) => {
    const res = await dispatcher.startNewSession(req);
    if (res.ok) {
      await refreshAndBroadcast();
    }
    return res;
  });

  ipcMain.handle(
    'sh:control-harness',
    async (
      _ev,
      harness: HarnessGroup,
      action: 'start_remote' | 'stop_remote' | 'open_desktop'
    ) => {
      const res = await dispatcher.controlHarness(harness, action);
      void refreshAndBroadcast();
      return res;
    }
  );

  ipcMain.handle('sh:organize', async (_ev, actions: OrganizeAction[]) => {
    const next = store.applyOrganize(actions);
    // Propagate native section moves upstream to drivers that support it (e.g. Codex app-server)
    for (const act of actions) {
      if (act.type === 'move_section' && act.sessionId) {
        const sess = registry.getSession(act.sessionId);
        if (sess && sess.harnessGroup !== 'master') {
          const driver = registry.getDriver(sess.harnessGroup);
          if (driver?.moveSection) {
            void driver.moveSection(sess, act.sectionName ?? null).catch(() => {});
          }
        }
      }
    }
    void refreshAndBroadcast();
    return next;
  });

  ipcMain.handle(
    'sh:archive-session',
    async (_ev, sessionId: string, opts?: { killTmux?: boolean }) => {
      const res = await dispatcher.archiveSession(sessionId, opts);
      void refreshAndBroadcast();
      return res;
    }
  );

  ipcMain.handle('sh:promote-tmux', async (_ev, sessionId: string) => {
    const res = await dispatcher.promoteToTmux(sessionId);
    if (res.ok) {
      setTimeout(() => void refreshAndBroadcast(), 1500);
    }
    return res;
  });

  ipcMain.handle('sh:update-settings', async (_ev, patch: Partial<SuperHarnessSettings>) => {
    const next = store.updateSettings(patch);
    void refreshAndBroadcast();
    return next;
  });

  ipcMain.handle('sh:clear-master', async () => {
    return store.clearMasterMessages();
  });

  ipcMain.handle('sh:pick-directory', async () => {
    if (!mainWindow) return null;
    const res = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
    });
    return res.canceled ? null : res.filePaths[0] ?? null;
  });

  ipcMain.handle('sh:system-apps', async () => {
    return detectSystemApps();
  });

  ipcMain.handle(
    'sh:read-file-preview',
    async (_ev, filePath: string, startLine?: number, endLine?: number) => {
      return readFilePreview(filePath, startLine, endLine);
    }
  );

  ipcMain.handle(
    'sh:open-path',
    async (
      _ev,
      targetPath: string,
      mode: 'auto' | 'internal' | 'editor' | 'file-manager' | 'terminal' | 'system' = 'auto',
      opts?: { line?: number; tmuxSession?: string }
    ) => {
      return openPathWithApp(targetPath, mode, store.getState().settings.apps, opts);
    }
  );

  ipcMain.handle('sh:open-external', async (_ev, url: string) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      await shell.openExternal(url);
      return { ok: true };
    }
    return { ok: false };
  });

  ipcMain.handle('sh:get-usage', async (_ev, force?: boolean) => {
    const snap = await usageService.getUsage(Boolean(force));
    broadcastToRenderer('sh:usage-updated', snap);
    return snap;
  });

  ipcMain.handle('sh:restart-app', async (_ev, opts?: { build?: boolean }) => {
    return scheduleDetachedRestart(opts);
  });
}

async function refreshUsageAndBroadcast(): Promise<void> {
  try {
    const snap = await usageService.getUsage(true);
    broadcastToRenderer('sh:usage-updated', snap);
    controlServer.broadcastEvent('usage', snap);
  } catch {
    // ignore background usage refresh failures
  }
}

function acquireSingleInstanceLock(): boolean {
  if (app.requestSingleInstanceLock()) return true;
  // When launched by our detached restart watchdog (`--restarted`), the previous
  // Electron instance may still be releasing SingletonLock for a few hundred ms.
  if (process.argv.includes('--restarted')) {
    const waitBuf = new Int32Array(new SharedArrayBuffer(4));
    for (let i = 0; i < 15; i++) {
      Atomics.wait(waitBuf, 0, 0, 120);
      if (app.requestSingleInstanceLock()) return true;
    }
  }
  return false;
}

const gotSingleInstanceLock = acquireSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    if (argv.includes('--replace') || argv.includes('--restart')) {
      void scheduleDetachedRestart();
      return;
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    } else {
      createWindow();
    }
  });
}

app.whenReady().then(async () => {
  if (!gotSingleInstanceLock) return;
  protocol.handle('sh-media', (request) => {
    try {
      const u = new URL(request.url);
      const filePath = decodeURIComponent(u.searchParams.get('path') || '');
      if (!filePath || !fs.existsSync(filePath)) {
        return new Response('Not found', { status: 404 });
      }
      const ext = path.extname(filePath).toLowerCase();
      if (u.searchParams.get('embed') === '1' && (ext === '.html' || ext === '.htm')) {
        const rawHtml = fs.readFileSync(filePath, 'utf8');
        const token = u.searchParams.get('token') || '';
        const html = injectEmbedPreviewRuntime(rawHtml, token);
        return new Response(html, {
          status: 200,
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
          },
        });
      }
      const videoMime: Record<string, string> = {
        '.mp4': 'video/mp4',
        '.m4v': 'video/mp4',
        '.webm': 'video/webm',
        '.mov': 'video/quicktime',
        '.mkv': 'video/x-matroska',
        '.avi': 'video/x-msvideo',
      };
      const contentType = videoMime[ext];
      if (contentType) {
        const stat = fs.statSync(filePath);
        const fileSize = stat.size;
        const rangeHeader = request.headers.get('range');
        if (rangeHeader) {
          const match = rangeHeader.match(/bytes=(\d*)-(\d*)/);
          if (match) {
            const start = match[1] ? Number(match[1]) : 0;
            const end = match[2] ? Math.min(Number(match[2]), fileSize - 1) : fileSize - 1;
            if (start < fileSize && start <= end) {
              const chunkSize = end - start + 1;
              const stream = fs.createReadStream(filePath, { start, end });
              return new Response(Readable.toWeb(stream) as never, {
                status: 206,
                headers: {
                  'Content-Type': contentType,
                  'Content-Length': String(chunkSize),
                  'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                  'Accept-Ranges': 'bytes',
                },
              });
            }
          }
        }
        const stream = fs.createReadStream(filePath);
        return new Response(Readable.toWeb(stream) as never, {
          status: 200,
          headers: {
            'Content-Type': contentType,
            'Content-Length': String(fileSize),
            'Accept-Ranges': 'bytes',
          },
        });
      }
      return net.fetch(pathToFileURL(filePath).toString());
    } catch {
      return new Response('Bad request', { status: 400 });
    }
  });

  await controlServer.start();
  await controlServer.syncMobileListener(store.getState().settings.mobileApi);
  registerIpcHandlers();
  createWindow();
  liveSync.start();
  schedulePolling(store.getState().settings.pollIntervalMs);
  void refreshUsageAndBroadcast();
  usageTimer = setInterval(() => {
    void refreshUsageAndBroadcast();
  }, 60_000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (pollTimer) clearInterval(pollTimer);
  if (usageTimer) clearInterval(usageTimer);
  liveSync.stop();
  dispatcher.shutdown();
  controlServer.close();
  closeSqlitePool();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
