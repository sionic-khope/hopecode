/** Text of an error thrown by `ipcRenderer.invoke`, without Electron's "Error invoking remote method" wrapper. */
export function ipcErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/^Error invoking remote method '[^']+':\s*/, '').replace(/^Error:\s*/, '');
}

