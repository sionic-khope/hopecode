// App lifecycle + service wiring (plan 4.2 index.ts, Wave 3).
// HOPECODE_FIXTURES=1 swaps every network / Keychain / CLI / dialog touchpoint for src/main/fixtures/**.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, powerMonitor } from 'electron';
import {
  ENV_FIXTURE_PROJECT,
  ENV_FIXTURES,
  ENV_SMOKE,
  LOGIN_URL_HOSTS,
  QUIT_DISPOSE_TIMEOUT_MS,
} from '../shared/constants';
import { isAppUrl } from './appUrl';
import { openExternalSafe } from './externalUrl';
import { createAccountPool } from './accounts/accountPool';
import { createConfigDirLinks } from './accounts/configDirLinks';
import { createCredentials } from './accounts/credentials';
import { startLoginFlow } from './accounts/loginFlow';
import { createClaudeBinary } from './claudeBinary';
import type { Broadcaster, Dialogs, QueryFn, TrustChoice, UsagePoller } from './contracts';
import { createFixtureQuery } from './fixtures/fakeQuery';
import {
  createFixtureCredentials,
  createFixtureDialogs,
  createFixtureRunCommand,
  createFixtureUsageClient,
  fixtureSpawnPty,
  seedFixtureAccounts,
} from './fixtures/fixtureServices';
import { createBroadcaster, registerIpc } from './ipc';
import { accountsDir, devEnv, hopecodeHome, initPaths, userDataDir } from './paths';
import { restrictPrivateModes } from './persistence/jsonl';
import { createStore } from './persistence/store';
import { createThreadLog } from './persistence/threadLog';
import { createUsageHistory } from './persistence/usageHistory';
import { createPtyManager } from './pty/ptyManager';
import { createSessionManager } from './session/sessionManager';
import { syncTranscript } from './session/transcriptSync';
import { createShellEnv } from './shellEnv';
import { createUsageClient } from './usage/usageClient';
import { createUsagePoller } from './usage/usagePoller';
import { appUrlConfig, createMainWindow, isHeadlessE2E } from './window';
import { createWorktreeManager } from './worktree/worktreeManager';

const require = createRequire(import.meta.url);

initPaths();

// Dev/test switches are ignored in a packaged app (L2); HOPECODE_SMOKE stays available for the packaged smoke check.
const fixtures = devEnv(ENV_FIXTURES) === '1';
const smoke = process.env[ENV_SMOKE] === '1';
const headless = isHeadlessE2E();

/** Smoke / e2e runs never put an icon in the Dock or take focus from the user's apps. */
function hideFromDock(): void {
  if (process.platform !== 'darwin') return;
  app.setActivationPolicy('accessory');
  app.dock?.hide();
}
/** Faster wait-scheduler tick in fixture mode so the e2e "all exhausted" countdown resumes in seconds. */
const FIXTURE_WAIT_TICK_MS = 1_000;

/** Native/ESM smoke (dev and packaged): SDK import, claude binary (asar.unpacked), node-pty spawn. */
async function nativeSmoke(): Promise<boolean> {
  let ok = true;
  try {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    console.log(`[smoke] sdk import ok (query: ${typeof sdk.query})`);
  } catch (err) {
    ok = false;
    console.error('[smoke] sdk import failed', err);
  }
  try {
    const binary = createClaudeBinary();
    const bin = binary.resolvePath();
    const version = await new Promise<string>((resolve, reject) => {
      execFile(bin, ['--version'], { timeout: 15_000, env: { PATH: '/usr/bin:/bin' } }, (err, stdout) =>
        err ? reject(err) : resolve(stdout.trim()),
      );
    });
    console.log(`[smoke] claude binary ok (${bin}) version: ${version}; manifest: ${binary.getCliVersion()}`);
    if (app.isPackaged && !bin.includes('app.asar.unpacked')) {
      ok = false;
      console.error('[smoke] packaged claude binary is not under app.asar.unpacked');
    }
  } catch (err) {
    ok = false;
    console.error('[smoke] claude binary failed', err);
  }
  try {
    const pty = require('node-pty') as typeof import('node-pty');
    const out = await new Promise<string>((resolve, reject) => {
      const p = pty.spawn('/bin/echo', ['pty-ok'], { cols: 80, rows: 24, cwd: process.cwd(), env: {} });
      let buf = '';
      const timer = setTimeout(() => reject(new Error('pty timeout')), 5000);
      p.onData((d) => (buf += d));
      p.onExit(() => {
        clearTimeout(timer);
        resolve(buf.trim());
      });
    });
    console.log(`[smoke] node-pty ok (output: ${out})`);
  } catch (err) {
    ok = false;
    console.error('[smoke] node-pty failed', err);
  }
  return ok;
}

interface Services {
  broadcaster: Broadcaster;
  dispose(): Promise<void>;
  /** Quit timeout: kill CLI processes / ptys and make a last short attempt to save state. */
  forceStop(): Promise<void>;
}

const INTERRUPTED_NOTICE = 'Interrupted: Hopecode quit while this turn was running.';

function focusedWindow(): BrowserWindow | undefined {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
}

async function showMessage(opts: Electron.MessageBoxOptions): Promise<number> {
  const win = focusedWindow();
  const res = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
  return res.response;
}

const nativeDialogs: Dialogs = {
  async pickProjectFolder() {
    const win = focusedWindow();
    const opts: Electron.OpenDialogOptions = { properties: ['openDirectory', 'createDirectory'] };
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    return res.canceled ? null : (res.filePaths[0] ?? null);
  },
  async confirmTrustProject(path) {
    const choices: TrustChoice[] = ['trust', 'dont-trust', 'cancel'];
    const response = await showMessage({
      type: 'question',
      buttons: ['Trust', "Don't Trust", 'Cancel'],
      defaultId: 1,
      cancelId: 2,
      message: 'Do you trust this folder?',
      detail: `${path}\n\nIf you trust it, the repository's .claude settings (hooks, permissions) are applied to sessions in this project. Hooks can run arbitrary commands.`,
    });
    return choices[response] ?? 'cancel';
  },
  async confirmBypassPermissions() {
    const response = await showMessage({
      type: 'warning',
      buttons: ['Cancel', 'Bypass Permissions'],
      defaultId: 0,
      cancelId: 0,
      message: 'Bypass all permission checks?',
      detail: 'Claude will run every tool, including shell commands and file edits, without asking. Only use this in a sandboxed or disposable environment.',
    });
    return response === 1;
  },
};

async function startServices(): Promise<Services> {
  const shellEnv = createShellEnv();
  await shellEnv.init();

  // Single broadcaster shared by every service.
  const broadcaster = createBroadcaster(() => BrowserWindow.getAllWindows());

  const dataDir = userDataDir();
  // Files from builds that predate the private modes (L7) are tightened once per start.
  await restrictPrivateModes(dataDir, ['threads', 'usage']);
  const threadLog = createThreadLog(join(dataDir, 'threads'));
  const store = createStore(join(dataDir, 'state.json'), {
    // Turns cut off by the last quit get a visible notice in their history (L3).
    onInterrupted: (threadIds) => {
      for (const threadId of threadIds) {
        void threadLog
          .append(threadId, { type: 'notice', id: `notice-${randomUUID()}`, level: 'warn', text: INTERRUPTED_NOTICE, createdAt: Date.now() })
          .catch((err: unknown) => console.error('[hopecode] interrupted notice failed', err));
      }
    },
  });
  await store.load();
  const usageHistory = createUsageHistory(join(dataDir, 'usage'));
  void usageHistory.compact().catch((err: unknown) => console.error('[hopecode] usage history compaction failed', err));

  const claudeBinary = createClaudeBinary();
  let cliVersion = claudeBinary.getCliVersion();

  if (fixtures) seedFixtureAccounts(store, accountsDir());
  const credentials = fixtures ? createFixtureCredentials() : createCredentials();
  const fixtureRunCommand = fixtures ? createFixtureRunCommand() : undefined;

  // AccountPool <-> UsagePoller are mutually dependent; connected through callbacks.
  let usagePoller: UsagePoller | null = null;
  const accountPool = createAccountPool({
    store,
    accountsDir,
    // Fixture mode links from an empty dir inside HOPECODE_HOME instead of the user's ~/.claude.
    links: createConfigDirLinks(fixtures ? join(hopecodeHome(), 'fixture-claude') : undefined),
    startLogin: (input) =>
      startLoginFlow(
        {
          claudePath: fixtures ? () => 'claude' : () => claudeBinary.resolvePath(),
          childEnv: (inject) => shellEnv.childEnv(inject),
          ...(fixtures
            ? { spawnPty: fixtureSpawnPty, runCommand: fixtureRunCommand }
            : { openExternal: (url: string) => void openExternalSafe(url, { allowHosts: LOGIN_URL_HOSTS }) }),
        },
        input,
      ),
    credentials,
    broadcaster,
    usageHistory,
    onAccountAdded: (account) => void usagePoller?.refresh(account.id),
  });

  const poller = createUsagePoller({
    listAccounts: () => accountPool.list(),
    credentials,
    client: fixtures ? createFixtureUsageClient() : createUsageClient(),
    cliVersion: () => cliVersion,
    history: usageHistory,
    // No broadcaster: registerIpc forwards onUpdate as usage:updated.
    watchAccounts: (cb) => accountPool.onChange(() => cb()),
  });
  usagePoller = poller;

  const ptyManager = createPtyManager({ shellEnv, broadcaster });
  const worktreeManager = createWorktreeManager({ env: () => shellEnv.childEnv({}) });

  let query: QueryFn;
  if (fixtures) {
    query = createFixtureQuery({ writeTranscript: true }).query;
  } else {
    query = (await import('@anthropic-ai/claude-agent-sdk')).query;
  }

  const session = createSessionManager({
    query,
    store,
    threadLog,
    listAccounts: () => accountPool.list(),
    usage: poller,
    shellEnv,
    claudeBinary: fixtures ? { resolvePath: () => 'claude' } : claudeBinary,
    broadcaster,
    appVersion: app.getVersion(),
    onCliVersion: (v) => {
      cliVersion = v;
    },
    ...(fixtures ? { waitTickMs: FIXTURE_WAIT_TICK_MS } : {}),
  });
  session.restore();
  powerMonitor.on('resume', () => void session.reevaluate());
  poller.onUpdate(() => void session.reevaluate());

  // Fixture / e2e runs never open a native dialog: every question is answered by the seam.
  const dialogs: Dialogs = fixtures || headless ? createFixtureDialogs(devEnv(ENV_FIXTURE_PROJECT)) : nativeDialogs;
  const urlConfig = appUrlConfig();

  const unregisterIpc = registerIpc(ipcMain, {
    store,
    threadLog,
    sessionManager: session,
    accountPool,
    usagePoller: poller,
    usageHistory,
    ptyManager,
    worktreeManager,
    dialogs,
    broadcaster,
    appVersion: app.getVersion(),
    isTrustedSender: (url) => isAppUrl(url, urlConfig),
    syncTranscript,
  });

  poller.start();

  return {
    broadcaster,
    async dispose() {
      poller.stop();
      await accountPool.cancelAllLogins().catch((err: unknown) => console.error('[hopecode] login cancel failed', err));
      await session.dispose().catch((err: unknown) => console.error('[hopecode] session dispose failed', err));
      ptyManager.killAll();
      unregisterIpc();
      await store.flush().catch((err: unknown) => console.error('[hopecode] store flush failed', err));
    },
    async forceStop() {
      session.abortAll();
      ptyManager.killAll();
      await Promise.race([
        store.flush().catch((err: unknown) => console.error('[hopecode] store flush failed', err)),
        new Promise((resolve) => setTimeout(resolve, 1_000)),
      ]);
    },
  };
}

function buildMenu(broadcaster: Broadcaster): Menu {
  return Menu.buildFromTemplate([
    { role: 'appMenu' },
    {
      label: 'File',
      submenu: [
        { label: 'New Thread', accelerator: 'CmdOrCtrl+N', click: () => broadcaster.emit('ui:newThread', undefined) },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        {
          label: 'Toggle Terminal',
          accelerator: 'CmdOrCtrl+J',
          click: () => broadcaster.emit('ui:toggleTerminal', undefined),
        },
        { type: 'separator' },
        { role: 'reload' },
        // DevTools only in development builds (L3).
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' } as const]),
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ]);
}

// Headless check only (no window, no services, no Dock icon): allowed in packaged builds to verify native modules.
if (smoke) {
  hideFromDock();
  void app.whenReady().then(async () => {
    hideFromDock();
    const ok = await nativeSmoke();
    console.log(`[smoke] ${ok ? 'PASS' : 'FAIL'}`);
    app.exit(ok ? 0 : 1);
  });
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  nativeTheme.themeSource = 'light';
  if (headless) hideFromDock();

  let services: Services | null = null;
  let quitting = false;

  app.on('second-instance', () => {
    if (headless) return;
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  void app.whenReady().then(async () => {
    try {
      services = await startServices();
    } catch (err) {
      console.error('[hopecode] failed to start services', err);
      if (!headless) dialog.showErrorBox('Hopecode failed to start', String(err));
      app.exit(1);
      return;
    }
    if (headless) hideFromDock();
    Menu.setApplicationMenu(buildMenu(services.broadcaster));
    createMainWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  });

  // Close Queries (deny pending permissions), kill ptys and flush state before exiting; a hung dispose
  // is cut off after QUIT_DISPOSE_TIMEOUT_MS (Queries aborted, app.exit) so quitting never hangs (M4).
  app.on('before-quit', (event) => {
    if (quitting || !services) return;
    event.preventDefault();
    quitting = true;
    const svc = services;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), QUIT_DISPOSE_TIMEOUT_MS);
    });
    const disposed = svc
      .dispose()
      .catch((err: unknown) => console.error('[hopecode] dispose failed', err))
      .then(() => 'done' as const);
    void Promise.race([disposed, timedOut]).then(async (result) => {
      clearTimeout(timer);
      if (result === 'done') {
        app.quit();
        return;
      }
      console.error(`[hopecode] dispose exceeded ${QUIT_DISPOSE_TIMEOUT_MS}ms; forcing exit`);
      await svc.forceStop().catch((err: unknown) => console.error('[hopecode] force stop failed', err));
      app.exit(0);
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
