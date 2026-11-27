import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type {
  HarnessDetection,
  HarnessGroup,
  OrganizeAction,
  StartSessionRequest,
  StreamEvent,
  SuperHarnessApi,
  SuperHarnessSettings,
  SuperHarnessState,
  UnifiedSession,
} from '../shared/types';

const api: SuperHarnessApi = {
  getBootstrap: () => ipcRenderer.invoke('sh:bootstrap'),
  getHarnessCatalog: (force?: boolean) => ipcRenderer.invoke('sh:catalog', force),
  createProjectDirectory: (parentDir: string, name: string) =>
    ipcRenderer.invoke('sh:create-project', parentDir, name),
  refreshDiscovery: () => ipcRenderer.invoke('sh:refresh'),
  getTranscript: (sessionId: string, limit?: number) =>
    ipcRenderer.invoke('sh:transcript', sessionId, limit),
  watchSession: (paneId: string, sessionId: string | null, limit?: number) =>
    ipcRenderer.invoke('sh:watch-session', paneId, sessionId, limit),
  captureTmux: (target: string) => ipcRenderer.invoke('sh:capture-tmux', target),
  saveAttachment: (dataUrl: string, filename?: string) =>
    ipcRenderer.invoke('sh:save-attachment', dataUrl, filename),
  readClipboardImage: () => ipcRenderer.invoke('sh:read-clipboard-image'),
  pickAttachmentFiles: () => ipcRenderer.invoke('sh:pick-attachment-files'),
  getPathForFile: (file: File) => {
    try {
      return webUtils.getPathForFile(file) || null;
    } catch {
      return null;
    }
  },
  sendMessage: (
    sessionId: string,
    prompt: string,
    attachments?: import('../shared/types').ImageAttachment[],
    opts?: { force?: boolean }
  ) => ipcRenderer.invoke('sh:send', sessionId, prompt, attachments, opts),
  queueMessage: (
    sessionId: string,
    prompt: string,
    attachments?: import('../shared/types').ImageAttachment[]
  ) => ipcRenderer.invoke('sh:queue-message', sessionId, prompt, attachments),
  abortRun: (sessionId: string) => ipcRenderer.invoke('sh:abort', sessionId),
  startSession: (req: StartSessionRequest) => ipcRenderer.invoke('sh:start-session', req),
  controlHarness: (
    harness: HarnessGroup,
    action: 'start_remote' | 'stop_remote' | 'open_desktop'
  ) => ipcRenderer.invoke('sh:control-harness', harness, action),
  organize: (actions: OrganizeAction[]) => ipcRenderer.invoke('sh:organize', actions),
  archiveSession: (sessionId: string, opts?: { killTmux?: boolean }) =>
    ipcRenderer.invoke('sh:archive-session', sessionId, opts),
  promoteToTmux: (sessionId: string) =>
    ipcRenderer.invoke('sh:promote-tmux', sessionId),
  updateSettings: (patch: Partial<SuperHarnessSettings>) =>
    ipcRenderer.invoke('sh:update-settings', patch),
  clearMasterHistory: () => ipcRenderer.invoke('sh:clear-master'),
  refreshSummaries: () => ipcRenderer.invoke('sh:refresh-summaries'),
  getSummaryStats: () => ipcRenderer.invoke('sh:get-summary-stats'),
  resetSummaryStats: () => ipcRenderer.invoke('sh:reset-summary-stats'),
  pickDirectory: () => ipcRenderer.invoke('sh:pick-directory'),
  getSystemApps: () => ipcRenderer.invoke('sh:system-apps'),
  readFilePreview: (filePath: string, startLine?: number, endLine?: number) =>
    ipcRenderer.invoke('sh:read-file-preview', filePath, startLine, endLine),
  openPath: (
    targetPath: string,
    mode?: 'auto' | 'internal' | 'editor' | 'file-manager' | 'terminal' | 'system',
    opts?: { line?: number; tmuxSession?: string }
  ) => ipcRenderer.invoke('sh:open-path', targetPath, mode, opts),
  openExternalUrl: (url: string) => ipcRenderer.invoke('sh:open-external', url),
  openInHarness: (sessionId: string) => ipcRenderer.invoke('sh:open-in-harness', sessionId),
  getUsage: (force?: boolean) => ipcRenderer.invoke('sh:get-usage', force),
  restartApp: (opts?: { build?: boolean }) => ipcRenderer.invoke('sh:restart-app', opts),
  getDictationStatus: (draft?: import('../shared/types').DictationSettings) =>
    ipcRenderer.invoke('sh:dictation-status', draft),
  transcribeAudio: (audio: Uint8Array, mimeType: string) =>
    ipcRenderer.invoke('sh:dictate', audio, mimeType),
  getMobileAccessInfo: () => ipcRenderer.invoke('sh:mobile-info'),
  openPairing: () => ipcRenderer.invoke('sh:pairing-open'),
  closePairing: () => ipcRenderer.invoke('sh:pairing-close'),
  revokePairedDevice: (deviceId: string) => ipcRenderer.invoke('sh:revoke-device', deviceId),
  checkHarnessUpdates: () => ipcRenderer.invoke('sh:harness-updates-check'),
  startHarnessUpdate: (harness: import('../shared/types').HarnessGroup) =>
    ipcRenderer.invoke('sh:harness-update-start', harness),
  cancelHarnessUpdate: (harness: import('../shared/types').HarnessGroup) =>
    ipcRenderer.invoke('sh:harness-update-cancel', harness),
  getHarnessUpdateJobs: () => ipcRenderer.invoke('sh:harness-update-jobs'),
  onHarnessUpdate: (cb: (job: import('../shared/types').HarnessUpdateJob) => void) => {
    const listener = (_ev: unknown, job: import('../shared/types').HarnessUpdateJob) => cb(job);
    ipcRenderer.on('sh:harness-update', listener);
    return () => {
      ipcRenderer.removeListener('sh:harness-update', listener);
    };
  },
  onPairingEvent: (cb: (ev: import('../shared/types').PairingEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, ev: import('../shared/types').PairingEvent) => cb(ev);
    ipcRenderer.on('sh:pairing-event', listener);
    return () => ipcRenderer.removeListener('sh:pairing-event', listener);
  },

  onStreamEvent: (cb: (ev: StreamEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: StreamEvent) => cb(payload);
    ipcRenderer.on('sh:stream', listener);
    return () => ipcRenderer.removeListener('sh:stream', listener);
  },

  onTranscriptUpdated: (
    cb: (result: import('../shared/types').SessionTranscriptResult) => void
  ) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: import('../shared/types').SessionTranscriptResult
    ) => cb(payload);
    ipcRenderer.on('sh:transcript-updated', listener);
    return () => ipcRenderer.removeListener('sh:transcript-updated', listener);
  },

  onStateChanged: (cb: (state: SuperHarnessState) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: SuperHarnessState) => cb(state);
    ipcRenderer.on('sh:state-changed', listener);
    return () => ipcRenderer.removeListener('sh:state-changed', listener);
  },

  onUsageUpdated: (cb: (usage: import('../shared/types').UsageSnapshot) => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      usage: import('../shared/types').UsageSnapshot
    ) => cb(usage);
    ipcRenderer.on('sh:usage-updated', listener);
    return () => ipcRenderer.removeListener('sh:usage-updated', listener);
  },

  onSessionsUpdated: (
    cb: (payload: { harnesses: HarnessDetection[]; sessions: UnifiedSession[] }) => void
  ) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      payload: { harnesses: HarnessDetection[]; sessions: UnifiedSession[] }
    ) => cb(payload);
    ipcRenderer.on('sh:sessions-updated', listener);
    return () => ipcRenderer.removeListener('sh:sessions-updated', listener);
  },
};

contextBridge.exposeInMainWorld('superHarness', api);
