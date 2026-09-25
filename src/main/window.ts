import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow } from 'electron';
import { ENV_E2E, ENV_RENDERER_URL } from '../shared/constants';
import { isAppUrl, type AppUrlConfig } from './appUrl';
import { openExternalSafe } from './externalUrl';
import { devEnv } from './paths';

const here = fileURLToPath(new URL('.', import.meta.url));

/** Where the renderer is loaded from: dev server (unpackaged only, L2) or the built index.html. */
export function appUrlConfig(): AppUrlConfig {
  const devUrl = devEnv(ENV_RENDERER_URL);
  return { devUrl: devUrl && devUrl.trim() ? devUrl : null, rendererIndexPath: join(here, '../renderer/index.html') };
}

/** HOPECODE_E2E=1 (unpackaged only): the window is never shown or focused on the user's screen. */
export function isHeadlessE2E(): boolean {
  return devEnv(ENV_E2E) === '1';
}

/** Main window (plan 5.1): hiddenInset title bar, sidebar vibrancy, sandboxed renderer. */
export function createMainWindow(): BrowserWindow {
  const cfg = appUrlConfig();
  const headless = isHeadlessE2E();
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 600,
    show: false,
    // Hidden e2e windows still render at a fixed size (layout assertions, screenshots).
    paintWhenInitiallyHidden: true,
    ...(headless ? { resizable: false } : {}),
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    vibrancy: 'sidebar',
    visualEffectState: 'followWindow',
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(here, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      // A never-shown e2e window must keep timers / animation frames running at full rate.
      ...(headless ? { backgroundThrottling: false } : {}),
    },
  });

  if (!headless) win.once('ready-to-show', () => win.show());

  // Links open in the browser (https only); the window itself never leaves the app (H1).
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (isAppUrl(url, cfg)) return;
    event.preventDefault();
    openExternalSafe(url);
  });
  win.webContents.on('will-redirect', (event, url) => {
    if (!isAppUrl(url, cfg)) event.preventDefault();
  });
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());

  if (cfg.devUrl) {
    void win.loadURL(cfg.devUrl);
  } else {
    void win.loadFile(cfg.rendererIndexPath);
  }
  return win;
}
