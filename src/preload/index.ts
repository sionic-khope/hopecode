// Sandboxed preload (built as CJS). Exposes exactly two typed functions on window.hopecode.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { isEventChannel, isInvokeChannel, type HopecodeApi } from '../shared/ipc';

const api: HopecodeApi = {
  invoke(channel, ...req) {
    if (!isInvokeChannel(channel)) return Promise.reject(new Error(`IPC channel not allowed: ${String(channel)}`));
    return ipcRenderer.invoke(channel, ...req);
  },
  on(channel, cb) {
    if (!isEventChannel(channel)) throw new Error(`IPC channel not allowed: ${String(channel)}`);
    const listener = (_e: IpcRendererEvent, payload: unknown): void => cb(payload as never);
    ipcRenderer.on(channel, listener);
    return () => {
      ipcRenderer.removeListener(channel, listener);
    };
  },
};

contextBridge.exposeInMainWorld('hopecode', api);
