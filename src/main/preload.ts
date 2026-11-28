import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { EVENT_CHANNELS, INVOKE_CHANNELS } from '../shared/ipcChannels';
import type { SuperHarnessApi } from '../shared/types';

const api: Record<string, unknown> = {
  getPathForFile: (file: File) => {
    try {
      return webUtils.getPathForFile(file) || null;
    } catch {
      return null;
    }
  },
};
for (const [method, channel] of Object.entries(INVOKE_CHANNELS)) {
  api[method] = (...args: unknown[]) => ipcRenderer.invoke(channel, ...args);
}
for (const [method, channel] of Object.entries(EVENT_CHANNELS)) {
  api[method] = (cb: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => {
      ipcRenderer.removeListener(channel, listener);
    };
  };
}

contextBridge.exposeInMainWorld('superHarness', api as unknown as SuperHarnessApi);
