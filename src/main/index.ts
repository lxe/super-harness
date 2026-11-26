import { app, BrowserWindow, clipboard, dialog, ipcMain, net, protocol, shell } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

let mainWindow: BrowserWindow | null = null;
let pollTimer: NodeJS.Timeout | null = null;
let usageTimer: NodeJS.Timeout | null = null;

const store = new ConfigStore();
const registry = new HarnessRegistry(store);
const usageService = new UsageService();
const catalogService = new HarnessCatalogService();

function broadcastToRenderer(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

const emitStream = (ev: StreamEvent) => {
  broadcastToRenderer('sh:stream', ev);
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
      broadcastToRenderer('sh:sessions-updated', result);
      return result;
    })
    .finally(() => {
      refreshInFlight = null;
    });
  return refreshInFlight;
}

const dispatcher = new HarnessDispatcher(registry, store, emitStream, () => {
  void refreshAndBroadcast();
});

const controlServer = new ControlServer(store, registry, dispatcher, async () => {
  await refreshAndBroadcast();
});

const liveSync = new LiveSyncService(
  registry,
  () => {
    void refreshAndBroadcast();
  },
  (transcript) => {
    broadcastToRenderer('sh:transcript-updated', transcript);
    controlServer.broadcastEvent('transcript_updated', {
      sessionId: transcript.sessionId,
      totalCount: transcript.totalCount,
      liveActivity: transcript.liveActivity,
    });
  }
);

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

store.subscribe((state) => {
  broadcastToRenderer('sh:state-changed', state);
  schedulePolling(state.settings.pollIntervalMs);
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

  const saveDataUrlAttachment = (dataUrl: string, filename?: string): ImageAttachment => {
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
  };

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
    async (_ev, sessionId: string, prompt: string, attachments?: ImageAttachment[]) => {
      if (sessionId === 'master:root') {
        return masterEngine.handlePrompt(prompt, attachments);
      }
      return dispatcher.sendToSession(sessionId, prompt, attachments);
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
}

async function refreshUsageAndBroadcast(): Promise<void> {
  try {
    const snap = await usageService.getUsage(true);
    broadcastToRenderer('sh:usage-updated', snap);
  } catch {
    // ignore background usage refresh failures
  }
}

app.whenReady().then(async () => {
  protocol.handle('sh-media', (request) => {
    try {
      const u = new URL(request.url);
      const filePath = decodeURIComponent(u.searchParams.get('path') || '');
      if (!filePath || !fs.existsSync(filePath)) {
        return new Response('Not found', { status: 404 });
      }
      return net.fetch(pathToFileURL(filePath).toString());
    } catch {
      return new Response('Bad request', { status: 400 });
    }
  });

  await controlServer.start();
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
