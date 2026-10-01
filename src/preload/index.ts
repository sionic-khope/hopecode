// Sandboxed preload (built as CJS). Exposes the typed invoke / on bridge and the composer drop helper on window.hopecode.
import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import { MAX_ATTACH_READ_BYTES, MAX_ATTACHMENTS, formatBytes } from '../core/attachments';
import { PRELOAD_ONLY_CHANNELS, isEventChannel, isInvokeChannel, type HopecodeApi } from '../shared/ipc';
import type { AttachRejection, AttachResult } from '../shared/types';

const preloadOnly: ReadonlySet<string> = new Set(PRELOAD_ONLY_CHANNELS);

const api: HopecodeApi = {
  invoke(channel, ...req) {
    if (!isInvokeChannel(channel) || preloadOnly.has(channel)) {
      return Promise.reject(new Error(`IPC channel not allowed: ${String(channel)}`));
    }
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
  // Only File objects the user dropped have a path (a File built in the page has none), so the renderer cannot make
  // main read a path of its choosing. Path-less files (dragged from a browser) go as bytes and get the same checks.
  async attachDropped(files) {
    const paths: string[] = [];
    const blobs: { name: string; bytes: Uint8Array }[] = [];
    const rejected: AttachRejection[] = [];
    for (const [i, file] of Array.from(files).entries()) {
      const path = webUtils.getPathForFile(file);
      if (i >= MAX_ATTACHMENTS) rejected.push({ name: file.name, reason: `한 메시지에 ${MAX_ATTACHMENTS}개까지 첨부할 수 있습니다` });
      else if (path) paths.push(path);
      else if (file.size > MAX_ATTACH_READ_BYTES) rejected.push({ name: file.name, reason: `${formatBytes(MAX_ATTACH_READ_BYTES)}보다 큽니다` });
      else blobs.push({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
    }
    const res = (await ipcRenderer.invoke('attach:drop', { paths, files: blobs })) as AttachResult;
    return { attachments: res.attachments, rejected: [...rejected, ...res.rejected] };
  },
};

contextBridge.exposeInMainWorld('hopecode', api);
