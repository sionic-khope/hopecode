// App lifecycle + service wiring (plan 4.2 index.ts, Wave 3).
// HOPECODE_FIXTURES=1 swaps every network / Keychain / CLI / dialog touchpoint for src/main/fixtures/**.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, powerMonitor, shell, clipboard, ClipboardItem, nativeImage } from 'electron';
import {
  CLIENT_APP_NAME,
  ENV_FIXTURE_PROJECT,
  ENV_FIXTURES,
  ENV_SMOKE,
  LOGIN_URL_HOSTS,
  QUIT_DISPOSE_TIMEOUT_MS,
} from '../shared/constants';
import type { EventChannel, EventPayload } from '../shared/ipc';
import type { AppInfo, ThreadStartRequest, ThreadStartResult } from '../shared/types';
import { isAppUrl } from './appUrl';
import { isSafeExternalUrl, openExternalSafe } from './externalUrl';
import { createAccountPool } from './accounts/accountPool';
import { createConfigDirLinks, defaultClaudeDir, sharedConfigStatus } from './accounts/configDirLinks';
import { createCredentials } from './accounts/credentials';
import { startLoginFlow } from './accounts/loginFlow';
import { createClaudeBinary } from './claudeBinary';
import type { Broadcaster, Dialogs, QueryFn, TrustChoice, UsagePoller } from './contracts';
import { createFixtureQuery } from './fixtures/fakeQuery';
import { createFixtureEditorLauncher } from './fixtures/fixtureEditors';
import { createFixturePublisher } from './fixtures/fixtureGit';
import { createEditorLauncher } from './editors/editorLauncher';
import { createGitPublisher, createGitService } from './git/gitService';
import { createModelCatalog, probeModels } from './models/modelCatalog';
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
import { createFixtureClock } from './fixtures/fixtureClock';
import { createFixturePrSource } from './fixtures/fixturePrs';
import { PR_URL_HOSTS } from './ipc/navHandlers';
import { createThreadSearchIndex } from './nav/threadSearchIndex';
import { readPluginInventory } from './plugins/pluginInventory';
import { createGhPrSource } from './prs/prService';
import { createScheduler } from './schedule/scheduler';

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

const INTERRUPTED_NOTICE = '중단됨: 이 턴이 실행 중일 때 Hopecode가 종료되었습니다.';

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
    const opts: Electron.OpenDialogOptions = { title: '폴더 선택', buttonLabel: '선택', properties: ['openDirectory', 'createDirectory'] };
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    return res.canceled ? null : (res.filePaths[0] ?? null);
  },
  async confirmTrustProject(path) {
    const choices: TrustChoice[] = ['trust', 'dont-trust', 'cancel'];
    const response = await showMessage({
      type: 'question',
      buttons: ['신뢰', '신뢰하지 않음', '취소'],
      defaultId: 1,
      cancelId: 2,
      message: '이 폴더를 신뢰하시겠습니까?',
      detail: `${path}\n\n신뢰하면 이 저장소의 .claude 설정(hooks, 권한)이 이 프로젝트의 세션에 적용됩니다. hooks는 임의의 명령을 실행할 수 있습니다.`,
    });
    return choices[response] ?? 'cancel';
  },
  async confirmBypassPermissions() {
    const response = await showMessage({
      type: 'warning',
      buttons: ['취소', '전체 액세스 허용'],
      defaultId: 0,
      cancelId: 0,
      message: '모든 권한 확인을 건너뛸까요?',
      detail: 'Claude가 셸 명령과 파일 편집을 포함한 모든 도구를 묻지 않고 실행합니다. 샌드박스나 버려도 되는 환경에서만 사용하세요.',
    });
    return response === 1;
  },
  async pickFiles(defaultPath) {
    const win = focusedWindow();
    const opts: Electron.OpenDialogOptions = {
      title: '파일 첨부',
      buttonLabel: '첨부',
      defaultPath,
      properties: ['openFile', 'multiSelections'],
    };
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    return res.canceled ? [] : res.filePaths;
  },
  async saveMarkdown(defaultName) {
    const win = focusedWindow();
    const opts: Electron.SaveDialogOptions = {
      title: 'Markdown으로 내보내기',
      buttonLabel: '저장',
      defaultPath: join(app.getPath('documents'), defaultName),
      filters: [{ name: 'Markdown', extensions: ['md'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    };
    const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    return res.canceled ? null : (res.filePath ?? null);
  },
};

async function startServices(): Promise<Services> {
  const shellEnv = createShellEnv();
  await shellEnv.init();

  // Single broadcaster shared by every service. Permission traffic also refreshes the Dock badge.
  const windowsBroadcaster = createBroadcaster(() => BrowserWindow.getAllWindows());
  let refreshBadge: () => void = () => {};
  const broadcaster: Broadcaster = {
    emit<K extends EventChannel>(channel: K, payload: EventPayload<K>) {
      windowsBroadcaster.emit(channel, payload);
      if (channel === 'permission:request' || channel === 'permission:cancel') refreshBadge();
    },
  };

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

  const modelCatalog = createModelCatalog({ filePath: join(dataDir, 'models.json'), broadcaster });
  await modelCatalog.load();

  if (fixtures) seedFixtureAccounts(store, accountsDir());
  const credentials = fixtures ? createFixtureCredentials() : createCredentials();
  const fixtureRunCommand = fixtures ? createFixtureRunCommand() : undefined;

  // AccountPool <-> UsagePoller are mutually dependent; connected through callbacks.
  let usagePoller: UsagePoller | null = null;
  let probeModelsOnce: () => void = () => {};
  // Fixture mode links from an empty dir inside HOPECODE_HOME instead of the user's ~/.claude.
  const sharedSourceDir = fixtures ? join(hopecodeHome(), 'fixture-claude') : defaultClaudeDir();
  const configLinks = createConfigDirLinks(sharedSourceDir);
  const accountPool = createAccountPool({
    store,
    accountsDir,
    links: configLinks,
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
    onAccountAdded: (account) => {
      void usagePoller?.refresh(account.id);
      // First account of a fresh install: learn the real model list right away.
      if (!modelCatalog.get()) probeModelsOnce();
    },
  });

  const poller = createUsagePoller({
    listAccounts: () => accountPool.list(),
    credentials,
    client: fixtures ? createFixtureUsageClient() : createUsageClient(),
    cliVersion: () => cliVersion,
    history: usageHistory,
    // No broadcaster: registerIpc forwards onUpdate as usage:updated.
    watchAccounts: (cb) => accountPool.onChange(() => cb()),
    // Settings > 계정 > 사용량 조회 간격; read before every poll.
    pollIntervalMs: () => store.get().settings.usagePollIntervalSec * 1000,
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
    models: modelCatalog,
    ...(fixtures ? { waitTickMs: FIXTURE_WAIT_TICK_MS } : {}),
  });
  session.restore();

  // Dock badge: threads waiting for a permission answer (never in test runs, which have no Dock icon).
  refreshBadge = () => {
    if (fixtures || headless || process.platform !== 'darwin') return;
    app.setBadgeCount(new Set(session.pendingPermissions().map((r) => r.threadId)).size);
  };

  // Message-less model probe (real runs only): initialize one CLI on the first usable account, read its model list,
  // close it. Failures keep the cached / fallback list.
  let probing = false;
  probeModelsOnce = () => {
    if (fixtures || headless || probing) return;
    const account = [...accountPool.list()].filter((a) => a.enabled).sort((a, b) => a.priority - b.priority)[0];
    if (!account) return;
    probing = true;
    void (async () => {
      try {
        const models = await probeModels({
          query,
          cwd: dataDir,
          env: shellEnv.childEnv({ configDir: account.configDir, clientApp: `${CLIENT_APP_NAME}/${app.getVersion()}` }),
          pathToClaudeCodeExecutable: claudeBinary.resolvePath(),
          log: (message) => console.log(message),
        });
        await modelCatalog.update(models);
      } catch (err) {
        console.error('[hopecode] model probe failed; keeping the cached model list', err);
      } finally {
        probing = false;
      }
    })();
  };
  probeModelsOnce();
  powerMonitor.on('resume', () => void session.reevaluate());
  poller.onUpdate(() => void session.reevaluate());

  // Fixture / e2e runs never open a native dialog: every question is answered by the seam.
  const dialogs: Dialogs = fixtures || headless ? createFixtureDialogs(devEnv(ENV_FIXTURE_PROJECT), join(hopecodeHome(), 'exports')) : nativeDialogs;
  const urlConfig = appUrlConfig();

  const gitEnv = () => shellEnv.childEnv({});
  // Fixture / e2e runs never push, open PRs or launch other apps: both go through recording seams.
  const gitService = createGitService({
    env: gitEnv,
    publisher: fixtures || headless ? createFixturePublisher() : createGitPublisher(gitEnv),
  });
  const editorLauncher = fixtures || headless ? createFixtureEditorLauncher() : createEditorLauncher();
  const sdkVersion = readSdkVersion();
  const sharedConfig = {
    status: () => sharedConfigStatus(accountPool.list(), sharedSourceDir),
    async relink() {
      for (const account of accountPool.list()) {
        await configLinks
          .linkSharedConfig(account.configDir)
          .catch((err: unknown) => console.error(`[hopecode] relink failed for ${account.alias}`, err));
      }
      return sharedConfigStatus(accountPool.list(), sharedSourceDir);
    },
  };

  // 예약: runs through the `thread:start` handler (bound once registerIpc hands it over). Fixture runs use a clock
  // e2e can move from the main process.
  let startThread: ((req: ThreadStartRequest) => Promise<ThreadStartResult>) | null = null;
  let tickSchedules: () => Promise<void> = async () => {};
  const fixtureClock = fixtures ? createFixtureClock(() => tickSchedules()) : null;
  if (fixtureClock) globalThis.__hopecodeFixtureClock = fixtureClock;
  const scheduler = createScheduler({
    filePath: join(dataDir, 'schedules.json'),
    now: fixtureClock ? fixtureClock.now : Date.now,
    projectIds: () => new Set(store.get().projects.map((p) => p.id)),
    startThread: (req) => (startThread ? startThread(req) : Promise.reject(new Error('thread:start is not ready'))),
    onChange: (schedules) => broadcaster.emit('schedule:updated', schedules),
  });
  tickSchedules = () => scheduler.tick();

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
    gitService,
    editorLauncher,
    appInfo: (): AppInfo => ({
      appVersion: app.getVersion(),
      cliVersion,
      sdkVersion,
      electronVersion: process.versions.electron ?? '',
      dataDir,
    }),
    async openDataFolder() {
      if (fixtures || headless) return; // never opens a Finder window in test runs
      const error = await shell.openPath(dataDir);
      if (error) throw new Error(error);
    },
    quit: () => app.quit(),
    images: {
      reveal(absPath) {
        if (fixtures || headless) return; // never opens a Finder window in test runs
        shell.showItemInFolder(absPath);
      },
      async copy(buffer) {
        // Normalized to PNG: the one bitmap type every macOS app pastes.
        const image = nativeImage.createFromBuffer(buffer);
        if (image.isEmpty()) throw new Error('unsupported image format');
        const png = image.toPNG();
        await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }) })]);
      },
    },
    sharedConfig,
    testMode: fixtures || headless,
    nav: {
      threadSearch: createThreadSearchIndex(threadLog),
      // Fixture / e2e runs never run gh or open a browser.
      prSource: fixtures || headless ? createFixturePrSource(() => store.get().threads) : createGhPrSource(gitEnv),
      openExternal: (url) =>
        fixtures || headless ? isSafeExternalUrl(url, PR_URL_HOSTS) : openExternalSafe(url, { allowHosts: PR_URL_HOSTS }),
      scheduler,
      plugins: {
        list: () => readPluginInventory(sharedSourceDir),
        async openFolder() {
          if (fixtures || headless) return; // never opens a Finder window in test runs
          const error = await shell.openPath(sharedSourceDir);
          if (error) throw new Error(error);
        },
      },
    },
    provideThreadStart: (start) => {
      startThread = start;
    },
    onSettingsChanged: (next, prev) => {
      // A new interval applies now: poll every account once, which reschedules on the new interval.
      if (next.usagePollIntervalSec !== prev.usagePollIntervalSec) void poller.refresh().catch(() => {});
      // Automatic switching turned back on: threads waiting on their own account may move now.
      if (next.autoSwitchAccounts && !prev.autoSwitchAccounts) void session.reevaluate();
    },
  });

  poller.start();
  await scheduler.load().catch((err: unknown) => console.error('[hopecode] schedules could not be loaded', err));
  scheduler.start();
  powerMonitor.on('resume', () => void scheduler.tick());

  return {
    broadcaster,
    async dispose() {
      poller.stop();
      scheduler.stop();
      await scheduler.flush().catch((err: unknown) => console.error('[hopecode] schedule flush failed', err));
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

/** @anthropic-ai/claude-agent-sdk version (its package.json sits next to the main entry; subpaths are not exported). */
function readSdkVersion(): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(dirname(require.resolve('@anthropic-ai/claude-agent-sdk')), 'package.json'), 'utf8')) as {
      version?: unknown;
    };
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

function buildMenu(broadcaster: Broadcaster): Menu {
  return Menu.buildFromTemplate([
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: '설정…', accelerator: 'CmdOrCtrl+,', click: () => broadcaster.emit('ui:openSettings', undefined) },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        { label: '새 채팅', accelerator: 'CmdOrCtrl+N', click: () => broadcaster.emit('ui:newThread', undefined) },
        {
          label: 'New Task Start',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => broadcaster.emit('ui:newTaskStart', undefined),
        },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        {
          label: '사이드바 보기/숨기기',
          accelerator: 'CmdOrCtrl+B',
          click: () => broadcaster.emit('ui:toggleSidebar', undefined),
        },
        {
          label: '하단 터미널 열기/닫기',
          accelerator: 'CmdOrCtrl+J',
          click: () => broadcaster.emit('ui:toggleTerminal', undefined),
        },
        {
          label: '변경사항 패널 열기/닫기',
          accelerator: 'CmdOrCtrl+Shift+D',
          click: () => broadcaster.emit('ui:toggleChanges', undefined),
        },
        {
          label: '명령 팔레트',
          accelerator: 'CmdOrCtrl+K',
          click: () => broadcaster.emit('ui:commandPalette', undefined),
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
      if (!headless) dialog.showErrorBox('Hopecode를 시작하지 못했습니다', String(err));
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
