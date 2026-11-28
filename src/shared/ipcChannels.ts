import type { SuperHarnessApi } from './types';

/** Bridge methods that push events (`onX(cb) => unsubscribe`). */
export type EventMethod = Extract<keyof SuperHarnessApi, `on${string}`>;
/** Bridge methods that call a main-process handler and return its answer. */
export type InvokeMethod = Exclude<keyof SuperHarnessApi, EventMethod | 'getPathForFile'>;

/**
 * The IPC channel behind each `window.superHarness` method. The Electron preload and the
 * browser bridge (web mode) both build the API from these tables, so they cannot drift.
 */
export const INVOKE_CHANNELS: { readonly [K in InvokeMethod]: string } = {
  getBootstrap: 'sh:bootstrap',
  getHarnessCatalog: 'sh:catalog',
  createProjectDirectory: 'sh:create-project',
  refreshDiscovery: 'sh:refresh',
  getTranscript: 'sh:transcript',
  watchSession: 'sh:watch-session',
  captureTmux: 'sh:capture-tmux',
  saveAttachment: 'sh:save-attachment',
  readClipboardImage: 'sh:read-clipboard-image',
  pickAttachmentFiles: 'sh:pick-attachment-files',
  sendMessage: 'sh:send',
  queueMessage: 'sh:queue-message',
  abortRun: 'sh:abort',
  startSession: 'sh:start-session',
  controlHarness: 'sh:control-harness',
  organize: 'sh:organize',
  archiveSession: 'sh:archive-session',
  promoteToTmux: 'sh:promote-tmux',
  updateSettings: 'sh:update-settings',
  clearMasterHistory: 'sh:clear-master',
  refreshSummaries: 'sh:refresh-summaries',
  getSummaryStats: 'sh:get-summary-stats',
  resetSummaryStats: 'sh:reset-summary-stats',
  pickDirectory: 'sh:pick-directory',
  getSystemApps: 'sh:system-apps',
  readFilePreview: 'sh:read-file-preview',
  openPath: 'sh:open-path',
  openExternalUrl: 'sh:open-external',
  openInHarness: 'sh:open-in-harness',
  getUsage: 'sh:get-usage',
  restartApp: 'sh:restart-app',
  getDictationStatus: 'sh:dictation-status',
  transcribeAudio: 'sh:dictate',
  getMobileAccessInfo: 'sh:mobile-info',
  openPairing: 'sh:pairing-open',
  closePairing: 'sh:pairing-close',
  revokePairedDevice: 'sh:revoke-device',
  checkHarnessUpdates: 'sh:harness-updates-check',
  startHarnessUpdate: 'sh:harness-update-start',
  cancelHarnessUpdate: 'sh:harness-update-cancel',
  getHarnessUpdateJobs: 'sh:harness-update-jobs',
};

export const EVENT_CHANNELS: { readonly [K in EventMethod]: string } = {
  onHarnessUpdate: 'sh:harness-update',
  onPairingEvent: 'sh:pairing-event',
  onStreamEvent: 'sh:stream',
  onTranscriptUpdated: 'sh:transcript-updated',
  onStateChanged: 'sh:state-changed',
  onUsageUpdated: 'sh:usage-updated',
  onSessionsUpdated: 'sh:sessions-updated',
};
