import { app, BrowserWindow, clipboard, dialog, ipcMain, net, protocol, shell } from 'electron';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import type {
  DictationResult,
  DictationSettings,
  HarnessGroup,
  MobileAccessInfo,
  MobileAddress,
  PairingSession,
  ImageAttachment,
  OrganizeAction,
  StartSessionRequest,
  StreamEvent,
  SuperHarnessSettings,
} from '../shared/types';
import { HarnessRegistry } from './adapters/registry';
import { createProjectDirectory, HarnessCatalogService } from './services/catalogService';
import { ControlServer } from './services/controlServer';
import { checkDictationServer, transcribeAudio } from './services/dictation';
import { PairingService } from './services/pairing';
import { BonjourAdvertiser } from './services/bonjourAdvertiser';
import { buildPairingUrl, defaultDesktopName, mobileAddresses } from './services/mobileAccess';
import QRCode from 'qrcode';
import { HarnessDispatcher } from './services/dispatcher';
import { LiveSyncService } from './services/liveSync';
import { MasterEngine } from './services/masterEngine';
import { PushNotifier } from './services/pushNotifier';
import {
  detectSystemApps,
  openPathWithApp,
  readFilePreview,
} from './services/systemLauncher';
import { SessionSummarizer } from './services/sessionSummarizer';
import { UsageService } from './services/usageService';
import { ConfigStore } from './store/configStore';
import { closeSqlitePool } from './utils/sqlite';
import { notificationTextFromMarkdown } from './utils/notificationText';
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

function classifyAttachmentKind(mimeType: string): 'image' | 'video' | 'file' {
  const lower = mimeType.toLowerCase();
  if (lower.startsWith('image/')) return 'image';
  if (lower.startsWith('video/')) return 'video';
  return 'file';
}

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  heic: 'image/heic',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  pdf: 'application/pdf',
  json: 'application/json',
  zip: 'application/zip',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  html: 'text/html',
};

function mimeTypeForPath(fp: string): string {
  return MIME_BY_EXT[path.extname(fp).toLowerCase().slice(1)] || 'application/octet-stream';
}

function saveRawBufferAttachment(
  buffer: Buffer,
  mimeType: string,
  filename?: string
): ImageAttachment & { sizeBytes: number; kind: 'image' | 'video' | 'file' } {
  const attachDir = path.join(os.homedir(), '.config', 'super-harness', 'attachments');
  fs.mkdirSync(attachDir, { recursive: true });
  const extMap: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'application/pdf': 'pdf',
    'text/plain': 'txt',
    'application/json': 'json',
  };
  const ext = extMap[mimeType.toLowerCase()] || 'bin';
  const id = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const safeName = (filename || `attachment-${id}.${ext}`).replace(/[^a-zA-Z0-9._-]/g, '_');
  const filePath = path.join(attachDir, `${id}-${safeName}`);
  fs.writeFileSync(filePath, buffer);
  return {
    id,
    name: safeName,
    path: filePath,
    mimeType: mimeType || 'application/octet-stream',
    sizeBytes: buffer.length,
    kind: classifyAttachmentKind(mimeType),
  };
}

function saveDataUrlAttachment(dataUrl: string, filename?: string): ImageAttachment {
  const match = dataUrl.match(/^data:([a-zA-Z0-9.+/-]+);base64,(.+)$/);
  const mimeType = match?.[1] || 'image/png';
  const base64 = match?.[2] || '';
  const saved = saveRawBufferAttachment(Buffer.from(base64, 'base64'), mimeType, filename);
  return {
    ...saved,
    previewDataUrl: mimeType.startsWith('image/') ? dataUrl : undefined,
  };
}

const pushNotifier = new PushNotifier(() => store.getState().settings.mobileApi?.token ?? '');
let defaultHostName = os.hostname().replace(/\.local$/, '') || 'Desktop';
void defaultDesktopName().then((name) => {
  defaultHostName = name;
  void syncBonjour();
});
const bonjourAdvertiser = new BonjourAdvertiser();
let mobileAddressCache: { at: number; list: MobileAddress[] } | null = null;
async function getMobileAddressesCached(force = false): Promise<MobileAddress[]> {
  if (!force && mobileAddressCache && Date.now() - mobileAddressCache.at < 15_000) return mobileAddressCache.list;
  const list = await mobileAddresses();
  mobileAddressCache = { at: Date.now(), list };
  return list;
}
/** Advertise over Bonjour only while the phone listener is up. */
async function syncBonjour(): Promise<void> {
  const port = controlServer.mobilePort;
  if (!port || !store.getState().settings.mobileApi?.enabled) {
    bonjourAdvertiser.sync(null);
    return;
  }
  const addresses = (await getMobileAddressesCached())
    .filter((a) => a.kind !== 'tailscale-dns')
    .map((a) => a.address);
  bonjourAdvertiser.sync({
    port,
    hostId: pairingService.hostId(),
    name: pairingService.hostName,
    addresses,
  });
}
const pairingService = new PairingService(store, {
  version: app.getVersion(),
  hostName: () => defaultHostName,
  onEvent: (ev) => broadcastToRenderer('sh:pairing-event', ev),
  onRevoke: (deviceId) => {
    controlServer.dropDeviceConnections(deviceId);
    pushNotifier.removePairedDevice(deviceId);
  },
});
const sessionWorkingSinceMs = new Map<string, number>();
const sessionNotifiedInputIds = new Set<string>();

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

// Mobile SSE: send only sessions that actually changed (full list is ~75 KB and
// re-rendering it several times per turn made the phone stutter).
let lastMobileSessionJsonById = new Map<string, string>();
let lastMobileSessionOrder = '';
let lastMobileHarnessesJson = '';

function broadcastSessionsDeltaToMobile(
  harnesses: Awaited<ReturnType<HarnessRegistry['discover']>>['harnesses'],
  sessions: Awaited<ReturnType<HarnessRegistry['discover']>>['sessions'],
  activeWorkingSessionIds: string[]
): void {
  const nextById = new Map<string, string>();
  const upserts: typeof sessions = [];
  for (const s of sessions) {
    const json = JSON.stringify(s);
    nextById.set(s.id, json);
    if (lastMobileSessionJsonById.get(s.id) !== json) upserts.push(s);
  }
  const removedIds = Array.from(lastMobileSessionJsonById.keys()).filter((id) => !nextById.has(id));
  const order = sessions.map((s) => s.id).join('\n');
  const orderChanged = order !== lastMobileSessionOrder;
  const harnessesJson = JSON.stringify(harnesses);
  const harnessesChanged = harnessesJson !== lastMobileHarnessesJson;
  if (upserts.length === 0 && removedIds.length === 0 && !orderChanged && !harnessesChanged) return;
  const isFirstBaseline = lastMobileSessionJsonById.size === 0;
  lastMobileSessionJsonById = nextById;
  lastMobileSessionOrder = order;
  lastMobileHarnessesJson = harnessesJson;
  // Clients always bootstrap (or resync after a host restart) before applying deltas,
  // so the very first snapshot after launch never needs to be pushed as a giant delta.
  if (isFirstBaseline) return;
  controlServerRef?.broadcastEvent('sessions_delta', {
    upserts,
    removedIds,
    order: orderChanged ? sessions.map((s) => s.id) : undefined,
    harnesses: harnessesChanged ? harnesses : undefined,
    activeWorkingSessionIds,
  });
}

// Drop duplicate transcript pushes (desktop + mobile panes watching the same session).
const lastTranscriptPushKeyBySession = new Map<string, string>();

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
      sessionSummarizer.noteSessions(sessions);
      broadcastToRenderer('sh:sessions-updated', decorated);
      broadcastSessionsDeltaToMobile(result.harnesses, sessions, activeWorkingSessionIds);
      lastBroadcastWorkingKey = activeWorkingSessionIds.join(',');
      return decorated;
    })
    .finally(() => {
      refreshInFlight = null;
    });
  return refreshInFlight;
}

// One-line "doing now" summaries for list rows, written in batches by a small model at idle times.
const sessionSummarizer = new SessionSummarizer({
  loadTranscript: (sessionId, limit) => registry.getTranscript(sessionId, limit),
  getWorkingIds: () => getActiveWorkingSessionIds(),
  getConfig: () => ({
    enabled: store.getState().settings.summaries?.enabled ?? true,
    model: store.getState().settings.summaries?.model || 'claude-haiku-5-5',
  }),
  onUpdated: () => {
    void refreshAndBroadcast();
  },
});
registry.setSummaryLookup((id) => sessionSummarizer.get(id));

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
    saveRawAttachment: async (buffer, mimeType, filename) =>
      saveRawBufferAttachment(buffer, mimeType, filename),
    queueMessage: async (sessionId, prompt, attachments) => {
      if (sessionId === 'master:root' && masterEngineRef) {
        return masterEngineRef.handlePrompt(prompt, attachments);
      }
      return dispatcher.queueToSession(sessionId, prompt, attachments);
    },
    registerPushDevice: (opts) => pushNotifier.registerDevice(opts),
    pairing: pairingService,
    sendTestPush: (opts) =>
      pushNotifier.notify(
        {
          kind: 'test',
          title: opts?.title || 'Super Harness',
          body: opts?.body || 'Push notifications are connected and working.',
        },
        { bypassCooldown: true }
      ),
    readFilePreview: async (filePath, startLine, endLine) =>
      readFilePreview(filePath, startLine, endLine),
    watchSession: async (paneId, sessionId, limit) => {
      if (liveSyncRef) {
        await liveSyncRef.watchPane(paneId, sessionId, limit ?? 80);
      }
    },
    getActiveWorkingSessionIds: () => getActiveWorkingSessionIds(),
    restartApp: async (opts) => scheduleDetachedRestart(opts),
    refreshSummaries: async (opts) => sessionSummarizer.refresh(opts),
    getSummaries: () => sessionSummarizer.getAll(),
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
      const wasWorking = liveWorkingSessionIds.has(transcript.sessionId);
      if (transcript.liveActivity.isWorking) {
        liveWorkingSessionIds.add(transcript.sessionId);
        if (!wasWorking) {
          sessionWorkingSinceMs.set(transcript.sessionId, Date.now());
          sessionNotifiedInputIds.delete(transcript.sessionId);
        }
      } else {
        liveWorkingSessionIds.delete(transcript.sessionId);
        const startedAt = sessionWorkingSinceMs.get(transcript.sessionId);
        sessionWorkingSinceMs.delete(transcript.sessionId);
        if (wasWorking && startedAt && Date.now() - startedAt >= 2000 && !transcript.sessionId.startsWith('master:')) {
          const sess = registry.getSession(transcript.sessionId);
          const lastAssistant = [...transcript.messages].reverse().find((m) => m.role === 'assistant');
          const snippet =
            notificationTextFromMarkdown(
              lastAssistant?.blocks
                .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
                .map((b) => b.text.trim())
                .join('\n\n') ?? ''
            ) || 'Task completed';
          void pushNotifier.notify({
            kind: 'task_completed',
            sessionId: transcript.sessionId,
            harness: sess?.harness,
            title: sess?.title || 'Task completed',
            body: snippet,
          });
        }
      }
      broadcastActivityIfChanged();
    }
    const lastMsgForPush = transcript.messages[transcript.messages.length - 1];
    const hasOpenQuestion = Boolean(
      lastMsgForPush?.blocks.some((b) => b.type === 'question' && !b.answered)
    );
    if (hasOpenQuestion && !sessionNotifiedInputIds.has(transcript.sessionId)) {
      sessionNotifiedInputIds.add(transcript.sessionId);
      const sess = registry.getSession(transcript.sessionId);
      const qBlock = lastMsgForPush?.blocks.find((b) => b.type === 'question' && !b.answered);
      const qText =
        qBlock && qBlock.type === 'question' && qBlock.questions?.[0]?.question
          ? qBlock.questions[0].question.slice(0, 160)
          : 'Waiting for your response';
      void pushNotifier.notify({
        kind: 'input_needed',
        sessionId: transcript.sessionId,
        harness: sess?.harness,
        title: `${sess?.title || 'Agent'} needs input`,
        body: qText,
      });
    }
    broadcastToRenderer('sh:transcript-updated', transcript);
    const lastMsg = transcript.messages[transcript.messages.length - 1];
    const lastBlock = lastMsg?.blocks[lastMsg.blocks.length - 1];
    const lastBlockLen =
      lastBlock && 'text' in lastBlock && typeof lastBlock.text === 'string'
        ? lastBlock.text.length
        : lastBlock && 'output' in lastBlock && typeof lastBlock.output === 'string'
          ? lastBlock.output.length
          : 0;
    const la = transcript.liveActivity;
    const stableActivityKey = la
      ? (() => {
          const { lastEventAt: _ignored, ...stable } = la;
          return JSON.stringify(stable);
        })()
      : '';
    const pushKey = [
      transcript.totalCount,
      transcript.messages.length,
      lastMsg?.id ?? '',
      lastMsg?.blocks.length ?? 0,
      lastBlockLen,
      stableActivityKey,
    ].join('|');
    if (lastTranscriptPushKeyBySession.get(transcript.sessionId) === pushKey) return;
    lastTranscriptPushKeyBySession.set(transcript.sessionId, pushKey);
    controlServer.broadcastEvent('transcript', transcript);
    controlServer.broadcastEvent('transcript_updated', {
      sessionId: transcript.sessionId,
      totalCount: transcript.totalCount,
      liveActivity: transcript.liveActivity,
    });
  }
);
liveSyncRef = liveSync;
// A session counts as read while it is open on the phone (mobile:<client> panes exist only
// while that client is connected) or in a desktop pane while the window has focus.
registry.setReadingLookup(() => {
  const desktopFocused = Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused());
  return liveSync.getWatchedSessionIds(
    (paneId) => paneId.startsWith('mobile:') || (desktopFocused && !paneId.startsWith('mobile'))
  );
});
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
  void controlServer.syncMobileListener(state.settings.mobileApi).then(() => syncBonjour());
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
    icon: path.join(app.getAppPath(), 'resources', 'icon.png'),
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

  // Opening the window marks the visible session read right away.
  mainWindow.on('focus', () => {
    void refreshAndBroadcast();
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

  // Attach any file. Images get an inline preview; other files are referenced by their path
  // (never copied or read here), and the dispatcher hands agents the path.
  ipcMain.handle('sh:pick-attachment-files', async (): Promise<ImageAttachment[]> => {
    if (!mainWindow) return [];
    const res = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections'],
    });
    if (res.canceled) return [];
    const out: ImageAttachment[] = [];
    for (const fp of res.filePaths) {
      try {
        const mimeType = mimeTypeForPath(fp);
        const isImage = mimeType.startsWith('image/');
        out.push({
          id: crypto.randomBytes(6).toString('hex'),
          name: path.basename(fp),
          path: fp,
          mimeType,
          previewDataUrl: isImage
            ? `data:${mimeType};base64,${fs.readFileSync(fp).toString('base64')}`
            : undefined,
        });
      } catch {
        // ignore unreadable file
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

  ipcMain.handle('sh:refresh-summaries', async () => sessionSummarizer.refresh({ force: true }));

  ipcMain.handle('sh:dictation-status', async (_ev, draft?: DictationSettings) =>
    checkDictationServer(draft ?? store.getState().settings.dictation)
  );

  ipcMain.handle(
    'sh:dictate',
    async (_ev, audio: Uint8Array, mimeType: string): Promise<DictationResult> => {
      try {
        const buf = Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength);
        const res = await transcribeAudio(store.getState().settings.dictation, buf, mimeType);
        return { ok: true, text: res.text, timing: res.timing };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
  );

  // Pairing codes go to the renderer only (shown in Settings → Mobile); never logged.
  ipcMain.handle('sh:mobile-info', async (): Promise<MobileAccessInfo> => ({
    hostId: pairingService.hostId(),
    hostName: pairingService.hostName,
    defaultHostName,
    listeningPort: controlServer.mobilePort,
    addresses: await getMobileAddressesCached(true),
    bonjour: bonjourAdvertiser.active,
  }));
  ipcMain.handle('sh:pairing-open', async (): Promise<PairingSession | { error: string }> => {
    const port = controlServer.mobilePort;
    if (!port) return { error: 'Turn on “Allow phones to connect” first.' };
    const hosts = (await getMobileAddressesCached()).map((a) => a.address);
    const { code, expiresAt } = pairingService.open();
    const url = buildPairingUrl({ name: pairingService.hostName, hostId: pairingService.hostId(), port, code, hosts });
    const qrDataUrl = await QRCode.toDataURL(url, { errorCorrectionLevel: 'M', margin: 1, width: 360 });
    return { code, expiresAt, url, qrDataUrl, hosts };
  });
  ipcMain.handle('sh:pairing-close', async () => pairingService.close('cancelled'));
  ipcMain.handle('sh:revoke-device', async (_ev, deviceId: string) => pairingService.revoke(deviceId));

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

function resolveLocalMediaPath(rawPath: string): string | null {
  if (!rawPath) return null;
  const expanded = rawPath.startsWith('~/') ? path.join(os.homedir(), rawPath.slice(2)) : rawPath;
  if (fs.existsSync(expanded)) return expanded;
  const base = path.basename(expanded);
  if (base && base !== '.' && base !== '..') {
    const localConfigAtt = path.join(os.homedir(), '.config', 'super-harness', 'attachments', base);
    if (fs.existsSync(localConfigAtt)) return localConfigAtt;
    const localCacheAtt = path.join(os.homedir(), '.cache', 'super-harness', 'attachments', base);
    if (fs.existsSync(localCacheAtt)) return localCacheAtt;
  }
  return null;
}

app.whenReady().then(async () => {
  if (!gotSingleInstanceLock) return;
  protocol.handle('sh-media', (request) => {
    try {
      const u = new URL(request.url);
      const rawPath = decodeURIComponent(u.searchParams.get('path') || '');
      const filePath = resolveLocalMediaPath(rawPath);
      if (!filePath) {
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
  void syncBonjour();
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
  bonjourAdvertiser.stop();
  controlServer.close();
  closeSqlitePool();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
