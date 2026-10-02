// Sandboxed preload (built as CJS). Exposes the typed invoke / on bridge and the composer drop helper on window.hopecode.
import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import { MAX_ATTACH_READ_BYTES, MAX_ATTACHMENTS, formatBytes } from '../core/attachments';
import { PRELOAD_ONLY_CHANNELS, isEventChannel, isInvokeChannel, type HopecodeApi } from '../shared/ipc';
import type { AttachRejection, AttachResult } from '../shared/types';
import { isLanguage, translate, type MessageKey, type MessageParams } from '../shared/i18n';

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
    // This world has its own copy of shared/i18n: the language comes from `<html lang>`, which the renderer keeps set.
    // (The preload is typed without the DOM lib.)
    const lang = (globalThis as { document?: { documentElement?: { lang?: string } } }).document?.documentElement?.lang;
    const tr = (key: MessageKey, params: MessageParams) => translate(isLanguage(lang) ? lang : 'en', key, params);
    for (const [i, file] of Array.from(files).entries()) {
      const path = webUtils.getPathForFile(file);
      if (i >= MAX_ATTACHMENTS) rejected.push({ name: file.name, reason: tr('attach.maxCount', { max: MAX_ATTACHMENTS }) });
      else if (path) paths.push(path);
      else if (file.size > MAX_ATTACH_READ_BYTES) rejected.push({ name: file.name, reason: tr('attach.tooLarge', { size: formatBytes(MAX_ATTACH_READ_BYTES) }) });
      else blobs.push({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
    }
    const res = (await ipcRenderer.invoke('attach:drop', { paths, files: blobs })) as AttachResult;
    return { attachments: res.attachments, rejected: [...rejected, ...res.rejected] };
  },
};

contextBridge.exposeInMainWorld('hopecode', api);
