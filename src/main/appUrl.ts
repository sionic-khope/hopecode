// Which URLs are the app itself (H1 navigation lock, M1 IPC sender check). No Electron import: testable.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface AppUrlConfig {
  /** Dev server URL (ELECTRON_RENDERER_URL); only honored for an unpackaged app. */
  devUrl: string | null;
  /** Absolute path of the built renderer index.html. */
  rendererIndexPath: string;
}

export function isAppUrl(url: string | null | undefined, cfg: AppUrlConfig): boolean {
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (cfg.devUrl) {
    try {
      if (parsed.origin === new URL(cfg.devUrl).origin && parsed.origin !== 'null') return true;
    } catch {
      // malformed dev URL: only the file:// renderer counts
    }
  }
  if (parsed.protocol !== 'file:' || parsed.host !== '') return false;
  try {
    return resolve(fileURLToPath(parsed)) === resolve(cfg.rendererIndexPath);
  } catch {
    return false;
  }
}
