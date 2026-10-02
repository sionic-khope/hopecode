// App lifecycle + service wiring (plan 4.2 index.ts, Wave 3).
// HOPECODE_FIXTURES=1 swaps every network / Keychain / CLI / dialog touchpoint for src/main/fixtures/**.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { app, BrowserWindow, dialog, ipcMain, Menu, powerMonitor, shell, clipboard, ClipboardItem, nativeImage } from 'electron';
import {
  CLIENT_APP_NAME,
  ENV_FIXTURE_PROJECT,
  ENV_FIXTURES,
  ENV_SMOKE,
  ENV_SYSTEM_LOCALE,
  LOGIN_URL_HOSTS,
  QUIT_DISPOSE_TIMEOUT_MS,
} from '../shared/constants';
import type { EventChannel, EventPayload } from '../shared/ipc';
import type { AppInfo, ThreadStartRequest, ThreadStartResult } from '../shared/types';
import { onLanguageChange, resolveLanguage, setLanguage, t, type LanguageSetting } from '../shared/i18n';
import { isAppUrl } from './appUrl';
import { isSafeExternalUrl, openExternalSafe } from './externalUrl';
import { createAccountPool } from './accounts/accountPool';
import { createConfigDirLinks } from './accounts/configDirLinks';
import { createCredentials } from './accounts/credentials';
import { syncLocalDefaultAccount } from './accounts/localDefault';
import { createSharedConfig, probeEnvInject } from './accounts/poolWiring';
import { buildAcpEnv } from '../core/acpEnv';
import { decodeJwtClaims } from '../core/jwtClaims';
import { createAcpLaunchers } from './agents/acpLaunchers';
import { createAgentBinaries, type AgentBinariesDeps } from './agents/agentBinaries';
import { codexAcpSmoke } from './agents/codexSmoke';
import { detectClaude } from './agents/localAuth/claudeDetector';
import { detectCodex } from './agents/localAuth/codexDetector';
import { codexMcpServerNames } from '../core/agentDefaults';
import { defaultDetectorDeps } from './agents/localAuth/detectorDeps';
import { detectHermes } from './agents/localAuth/hermesDetector';
import { createLocalAuthService } from './agents/localAuth/localAuthService';
import { createAcpFixtureLauncher } from './fixtures/acpFixtureLaunchers';
import { createFixtureLocalAuth } from './fixtures/fixtureLocalAuth';
import { scratchGitCeiling } from './scratch/scratchDirs';
import { createAgentUsageService, createHermesExec } from './usage/agentUsage';
import { startLoginFlow } from './accounts/loginFlow';
import { createClaudeBinary } from './claudeBinary';
import type { Broadcaster, Dialogs, LocalAuthService, QueryFn, TrustChoice, UsagePoller } from './contracts';
import { createFixtureQuery } from './fixtures/fakeQuery';
import { createFixtureEditorLauncher } from './fixtures/fixtureEditors';
import { createFixturePublisher } from './fixtures/fixtureGit';
import { createEditorLauncher } from './editors/editorLauncher';
import { createGitPublisher, createGitService } from './git/gitService';
import { createModelCatalog, probeModels } from './models/modelCatalog';
import {
  createFixtureCredentials,
  createFixtureDialogs,
  createFixtureHermesExec,
  createFixtureRunCommand,
  createFixtureUsageClient,
  fixtureSpawnPty,
  seedFixtureAccounts,
} from './fixtures/fixtureServices';
import { createBroadcaster, registerIpc } from './ipc';
import { accountsDir, devEnv, hopecodeHome, initPaths, localClaudeDir, userDataDir } from './paths';
import { restrictPrivateModes } from './persistence/jsonl';
import { createStore } from './persistence/store';
import { createThreadLog } from './persistence/threadLog';
import { createMediaStore } from './images/mediaStore';
import { createUsageHistory } from './persistence/usageHistory';
import { createPtyManager } from './pty/ptyManager';
import { createSessionManager } from './session/sessionManager';
import { syncTranscript } from './session/transcriptSync';
import { createShellEnv } from './shellEnv';
import { createUsageClient } from './usage/usageClient';
import { createUsagePoller } from './usage/usagePoller';
import { appUrlConfig, createMainWindow, isHeadlessE2E } from './window';
import { setupTheme, themeOverlay } from './theme/themeProtocol';
import { createWorktreeManager } from './worktree/worktreeManager';
import { createFixtureClock } from './fixtures/fixtureClock';
import { createFixturePrSource } from './fixtures/fixturePrs';
import { PR_URL_HOSTS } from './ipc/navHandlers';
import { createThreadSearchIndex } from './nav/threadSearchIndex';
import { readPluginInventory } from './plugins/pluginInventory';
import { AttachmentStore } from './attachments/attachmentStore';
import { imagePixelProblem, type ImageMediaType } from '../core/attachments';
import { createSlashCommandService } from './commands/slashCommands';
import { createGhPrSource } from './prs/prService';
import { createScheduler } from './schedule/scheduler';
import { createNoteWatcher } from './notes/noteWatcher';
import { createNoteChats } from './notes/noteChats';
import { createNoteGit } from './notes/noteGit';
import { runNoteAi } from './notes/noteAi';

const require = createRequire(import.meta.url);

initPaths();

// Dev/test switches are ignored in a packaged app (L2); HOPECODE_SMOKE stays available for the packaged smoke check.
const fixtures = devEnv(ENV_FIXTURES) === '1';
const smoke = process.env[ENV_SMOKE] === '1';
// The smoke check never writes into the user's data: Chromium gets a throwaway userData (appData ignores $HOME).
if (smoke) app.setPath('userData', mkdtempSync(join(tmpdir(), 'deltax-smoke-')));
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
  ok = (await codexAcpSmokeAll()) && ok;
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

/** Where the bundled codex-acp adapter lives: extraResources `bin/` when packaged, `build/bin/` in dev / test. */
function adapterLocation(): Pick<AgentBinariesDeps, 'resourcesPath' | 'appRoot'> {
  return app.isPackaged ? { resourcesPath: process.resourcesPath } : { appRoot: app.getAppPath() };
}

/** ACP SDK + zod import, then the Codex adapter / engine / offline initialize check (agents/codexSmoke.ts). */
async function codexAcpSmokeAll(): Promise<boolean> {
  try {
    const acp = await import('@agentclientprotocol/sdk');
    const zod = await import('zod');
    console.log(`[smoke] acp sdk import ok (protocol v${acp.PROTOCOL_VERSION}, zod: ${typeof zod.z})`);
  } catch (err) {
    console.error('[smoke] acp sdk / zod import failed', err);
    return false;
  }
  return codexAcpSmoke({
    // No settings override, no login-shell PATH: the fixed install locations only.
    binaries: createAgentBinaries({ loginEnv: () => ({}), ...adapterLocation() }),
    ...(app.isPackaged ? { requiredDir: join(process.resourcesPath, 'bin') } : {}),
    appVersion: app.getVersion(),
    log: (line) => console.log(line),
    error: (line, err) => (err === undefined ? console.error(line) : console.error(line, err)),
  });
}

interface Services {
  broadcaster: Broadcaster;
  dispose(): Promise<void>;
  /** Quit timeout: kill CLI processes / ptys and make a last short attempt to save state. */
  forceStop(): Promise<void>;
}

/** OS locale `language: 'system'` resolves against; fixture / e2e runs may pin it (HOPECODE_SYSTEM_LOCALE). */
function systemLocale(): string {
  return devEnv(ENV_SYSTEM_LOCALE)?.trim() || app.getLocale();
}

/** Menus, native dialogs, notifications and agent errors from main follow `settings.language`. */
function applyMainLanguage(setting: LanguageSetting): void {
  setLanguage(resolveLanguage(setting, systemLocale()));
}

function focusedWindow(): BrowserWindow | undefined {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
}

async function showMessage(opts: Electron.MessageBoxOptions): Promise<number> {
  const win = focusedWindow();
  const res = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
  return res.response;
}

/**
 * Composer image over the API's size limit: scaled down (long edge 2048 -> 1568 -> 1024 px) until its encoding fits;
 * PNG stays PNG when it can, otherwise JPEG. null when the image cannot be decoded or never fits.
 */
function resizeWithNativeImage(bytes: Buffer, mediaType: ImageMediaType, maxBytes: number): { bytes: Buffer; mediaType: ImageMediaType } | null {
  // Header check before nativeImage decodes in main (decompression bomb); AttachmentStore checked already.
  if (imagePixelProblem(bytes)) return null;
  const image = nativeImage.createFromBuffer(bytes);
  if (image.isEmpty()) return null;
  const { width, height } = image.getSize();
  for (const edge of [2048, 1568, 1024]) {
    const scale = Math.min(1, edge / Math.max(width, height));
    const scaled = scale < 1 ? image.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: 'best' }) : image;
    if (mediaType === 'image/png') {
      const png = scaled.toPNG();
      if (png.length <= maxBytes) return { bytes: png, mediaType: 'image/png' };
    }
    const jpeg = scaled.toJPEG(85);
    if (jpeg.length <= maxBytes) return { bytes: jpeg, mediaType: 'image/jpeg' };
  }
  return null;
}

const nativeDialogs: Dialogs = {
  async pickProjectFolder() {
    const win = focusedWindow();
    const opts: Electron.OpenDialogOptions = { title: t('main.dialog.pickFolder.title'), buttonLabel: t('main.dialog.pickFolder.button'), properties: ['openDirectory', 'createDirectory'] };
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    return res.canceled ? null : (res.filePaths[0] ?? null);
  },
  async confirmTrustProject(path) {
    const choices: TrustChoice[] = ['trust', 'dont-trust', 'cancel'];
    const response = await showMessage({
      type: 'question',
      buttons: [t('main.dialog.trust.trust'), t('main.dialog.trust.dontTrust'), t('common.cancel')],
      defaultId: 1,
      cancelId: 2,
      message: t('main.dialog.trust.message'),
      detail: `${path}\n\n${t('main.dialog.trust.detail')}`,
    });
    return choices[response] ?? 'cancel';
  },
  async confirmBypassPermissions() {
    const response = await showMessage({
      type: 'warning',
      buttons: [t('common.cancel'), t('main.dialog.bypass.allow')],
      defaultId: 0,
      cancelId: 0,
      message: t('main.dialog.bypass.message'),
      detail: t('main.dialog.bypass.detail'),
    });
    return response === 1;
  },
  async pickFiles(defaultPath) {
    const win = focusedWindow();
    const opts: Electron.OpenDialogOptions = {
      title: t('main.dialog.attach.title'),
      buttonLabel: t('main.dialog.attach.button'),
      defaultPath,
      properties: ['openFile', 'multiSelections'],
    };
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    return res.canceled ? [] : res.filePaths;
  },
  async saveMarkdown(defaultName) {
    const win = focusedWindow();
    const opts: Electron.SaveDialogOptions = {
      title: t('main.dialog.exportMarkdown.title'),
      buttonLabel: t('common.save'),
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
  await restrictPrivateModes(dataDir, ['threads', 'usage', 'media']);
  const media = createMediaStore(join(dataDir, 'media'), (message, err) => console.error(message, err ?? ''));
  const threadLog = createThreadLog(join(dataDir, 'threads'), { media });
  const store = createStore(join(dataDir, 'state.json'), {
    // Turns cut off by the last quit get a visible notice in their history (L3).
    onInterrupted: (threadIds) => {
      // Called inside load(): the stored language is already readable and the notice is written in it.
      applyMainLanguage(store.get().settings.language);
      for (const threadId of threadIds) {
        void threadLog
          .append(threadId, { type: 'notice', id: `notice-${randomUUID()}`, level: 'warn', text: t('main.interruptedNotice'), createdAt: Date.now() })
          .catch((err: unknown) => console.error('[deltax] interrupted notice failed', err));
      }
    },
  });
  await store.load();
  applyMainLanguage(store.get().settings.language);
  const usageHistory = createUsageHistory(join(dataDir, 'usage'));
  void usageHistory.compact().catch((err: unknown) => console.error('[deltax] usage history compaction failed', err));

  const claudeBinary = createClaudeBinary();
  let cliVersion = claudeBinary.getCliVersion();

  const modelCatalog = createModelCatalog({ filePath: join(dataDir, 'models.json'), broadcaster });
  await modelCatalog.load();

  if (fixtures) seedFixtureAccounts(store, accountsDir());
  const credentials = fixtures ? createFixtureCredentials() : createCredentials({ localClaudeDir });
  const fixtureRunCommand = fixtures ? createFixtureRunCommand() : undefined;

  // AccountPool <-> UsagePoller are mutually dependent; connected through callbacks.
  let usagePoller: UsagePoller | null = null;
  let probeModelsOnce: () => void = () => {};
  // Fixture mode links from an empty dir inside HOPECODE_HOME instead of the user's ~/.claude.
  const sharedSourceDir = fixtures ? join(hopecodeHome(), 'fixture-claude') : localClaudeDir();
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
    localClaudeDir,
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

  // Local agent logins (plan 2.9). Fixture runs never read ~/.codex, the Keychain or run claude / hermes.
  const agentBinaries = createAgentBinaries({
    loginEnv: () => shellEnv.baseEnv(),
    ...adapterLocation(),
    codexOverride: () => store.get().settings.codexPath,
  });
  const detectedAuth: LocalAuthService = fixtures
    ? createFixtureLocalAuth(process.env)
    : createLocalAuthService({
        detectors: {
          'claude-code': () =>
            detectClaude({
              ...defaultDetectorDeps(),
              claudePath: () => claudeBinary.resolvePath(),
              childEnv: (inject) => shellEnv.childEnv(inject),
            }),
          codex: () =>
            detectCodex({
              ...defaultDetectorDeps(),
              codexAcpPath: () => agentBinaries.resolveCodexAcp(),
              codexEngine: () => agentBinaries.resolveCodex(),
              codexEngineError: () => agentBinaries.codexEngineError(),
              env: () => shellEnv.baseEnv(),
              decodeJwtClaims,
            }),
          hermes: (opts) =>
            detectHermes(
              {
                ...defaultDetectorDeps(),
                hermesPath: () => agentBinaries.resolveHermes(),
                // Same scrubbed env as the Hermes ACP process (no Claude / deltax variables).
                env: () => buildAcpEnv(shellEnv.baseEnv(), { agent: 'hermes' }),
              },
              opts,
            ),
        },
      });
  // A forced recheck (재확인) also re-resolves the codex-acp / codex engine / hermes paths.
  const localAuth: LocalAuthService = {
    ...detectedAuth,
    recheck(agent, opts) {
      if (opts?.force) agentBinaries.invalidate();
      return detectedAuth.recheck(agent, opts);
    },
  };
  // Every Claude detection result applies the local-account enrollment rule (plan 2.9.5).
  localAuth.onChange((list) => {
    syncLocalDefaultAccount(
      { pool: accountPool, settings: () => store.get().settings, fixtures },
      list.find((info) => info.agent === 'claude-code'),
    );
  });

  const agentUsage = createAgentUsageService({
    hermes: () => {
      if (fixtures) return localAuth.availability('hermes').usable ? createFixtureHermesExec() : null;
      const bin = agentBinaries.resolveHermes();
      return bin ? createHermesExec(bin, buildAcpEnv(shellEnv.baseEnv(), { agent: 'hermes' })) : null;
    },
    broadcaster,
    log: (message) => console.log(message),
  });

  // Codex / Hermes processes: the bundled codex-acp and `hermes acp`, or the scripted fixture agent (dev only:
  // process.execPath + ELECTRON_RUN_AS_NODE, which the packaged app's runAsNode fuse disables).
  const acpLaunchers = fixtures
    ? {
        // HOPECODE_FIXTURE_CODEX_PROFILE=noload: the Codex agent has no session/load (e2e restart notice).
        codex: createAcpFixtureLauncher({
          profile: devEnv('HOPECODE_FIXTURE_CODEX_PROFILE') === 'noload' ? 'noload' : 'codex',
          scriptPath: join(app.getAppPath(), 'tests', 'fixtures', 'acp', 'fakeAcpAgent.mjs'),
          stateDir: join(hopecodeHome(), 'fake-acp'),
        }),
        hermes: createAcpFixtureLauncher({
          profile: 'hermes',
          scriptPath: join(app.getAppPath(), 'tests', 'fixtures', 'acp', 'fakeAcpAgent.mjs'),
          stateDir: join(hopecodeHome(), 'fake-acp'),
        }),
      }
    : createAcpLaunchers({
        binaries: agentBinaries,
        baseEnv: () => shellEnv.baseEnv(),
        // Never the project directory: a bun-compiled adapter must not see a repository's bunfig.toml / .env.
        codexProcessCwd: () => {
          const dir = join(hopecodeHome(), 'run', 'codex-acp');
          mkdirSync(dir, { recursive: true, mode: 0o700 });
          chmodSync(dir, 0o700);
          return dir;
        },
      });

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
    acpLaunchers,
    scratchRoot: scratchGitCeiling(),
    // Hermes' initialize probe spawns a process: an auth failure re-reads only its cached state (plan 2.9.3).
    onAgentProblem: (agent) => void localAuth.recheck(agent, { force: agent !== 'hermes' }).catch(() => {}),
    onAcpTurnEnd: (agent) => void agentUsage.refresh(agent).catch(() => {}),
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
          env: shellEnv.childEnv(probeEnvInject(account, `${CLIENT_APP_NAME}/${app.getVersion()}`)),
          pathToClaudeCodeExecutable: claudeBinary.resolvePath(),
          log: (message) => console.log(message),
        });
        await modelCatalog.update(models);
      } catch (err) {
        console.error('[deltax] model probe failed; keeping the cached model list', err);
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
  // The local Claude account IS the shared source (~/.claude): never linked, never reported.
  const sharedConfig = createSharedConfig({ accountPool, links: configLinks, sourceDir: sharedSourceDir });

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

  // 노트 모드: the active vault's watcher, and one signal that stops every note AI request on quit.
  const notesWatcher = createNoteWatcher(
    (change) => broadcaster.emit('notes:changed', change),
    (message, err) => console.error(message, err ?? ''),
  );
  const notesAbort = new AbortController();

  const unregisterIpc = registerIpc(ipcMain, {
    store,
    threadLog,
    sessionManager: session,
    accountPool,
    localAuth,
    agentUsage,
    fixtures,
    usagePoller: poller,
    usageHistory,
    ptyManager,
    worktreeManager,
    dialogs,
    broadcaster,
    appVersion: app.getVersion(),
    isTrustedSender: (url) => isAppUrl(url, urlConfig),
    themeOverlay,
    attachments: new AttachmentStore({ resizeImage: resizeWithNativeImage }),
    // Composer `/` picker: read-only scan of the shared config (~/.claude, or the fixture folder in test runs);
    // user skills may be links into ~/.agents/skills (skills.sh installs), nothing else outside is read.
    slashCommands: createSlashCommandService({
      userDir: sharedSourceDir,
      extraRoots: [join(dirname(sharedSourceDir), '.agents', 'skills')],
      live: (threadId) => session.supportedCommands(threadId),
      log: (message, err) => console.error(message, err ?? ''),
    }),
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
      async save(buffer, name) {
        let target: string | null;
        if (fixtures || headless) {
          // Test runs never open a dialog: the file lands in the exports folder.
          const dir = join(hopecodeHome(), 'exports');
          await mkdir(dir, { recursive: true });
          target = join(dir, basename(name));
        } else {
          const win = focusedWindow();
          const opts: Electron.SaveDialogOptions = {
            title: t('main.dialog.saveImage.title'),
            buttonLabel: t('common.save'),
            defaultPath: join(app.getPath('downloads'), basename(name)),
            properties: ['createDirectory', 'showOverwriteConfirmation'],
          };
          const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
          target = res.canceled ? null : (res.filePath ?? null);
        }
        if (!target) return false;
        await writeFile(target, buffer);
        return true;
      },
    },
    media,
    sharedConfig,
    testMode: fixtures || headless,
    systemLocale,
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
    notes: {
      async pickFolder() {
        // Test runs never open a dialog: the seam answers with an e2e-set folder or HOPECODE_FIXTURE_NOTES.
        if (fixtures || headless) return globalThis.__hopecodeFixtureNoteVault ?? devEnv('HOPECODE_FIXTURE_NOTES') ?? null;
        const win = focusedWindow();
        const opts: Electron.OpenDialogOptions = { title: t('main.dialog.pickNoteFolder.title'), buttonLabel: t('main.dialog.pickFolder.button'), properties: ['openDirectory', 'createDirectory'] };
        const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
        return res.canceled ? null : (res.filePaths[0] ?? null);
      },
      async trash(abs) {
        if (fixtures || headless) {
          // Test runs never fill the user's Trash: the entry moves into HOPECODE_HOME.
          const dir = join(hopecodeHome(), 'fixture-trash', randomUUID());
          await mkdir(dir, { recursive: true });
          await rename(abs, join(dir, basename(abs)));
          return;
        }
        await shell.trashItem(abs);
      },
      openExternal: (url) => (fixtures || headless ? isSafeExternalUrl(url) : openExternalSafe(url)),
      git: createNoteGit(gitEnv),
      chats: createNoteChats(join(dataDir, 'notes', 'chats')),
      watcher: notesWatcher,
      runAi: (run, onDelta, signal) =>
        runNoteAi(
          {
            query,
            listAccounts: () => accountPool.list(),
            usage: poller,
            shellEnv,
            claudeBinary: fixtures ? { resolvePath: () => 'claude' } : claudeBinary,
            appVersion: app.getVersion(),
            codexLauncher: acpLaunchers.codex,
            codexUsable: () => localAuth.availability('codex').usable,
            // Read-only look at the user's Codex config (`$CODEX_HOME/config.toml`) for MCP server names; never in
            // fixture runs (the fake agent has none).
            codexMcpServers: () => {
              if (fixtures) return [];
              const env = shellEnv.baseEnv();
              const home = env.CODEX_HOME ? env.CODEX_HOME : join(homedir(), '.codex');
              try {
                return codexMcpServerNames(readFileSync(join(home, 'config.toml'), 'utf8'));
              } catch {
                return [];
              }
            },
            runDir: join(hopecodeHome(), 'run', 'notes'),
            now: Date.now,
            log: (message, err) => console.error(message, err ?? ''),
          },
          run,
          onDelta,
          AbortSignal.any([signal, notesAbort.signal]),
        ),
    },
    provideThreadStart: (start) => {
      startThread = start;
    },
    onSettingsChanged: (next, prev) => {
      if (next.language !== prev.language) applyMainLanguage(next.language);
      // A new interval applies now: poll every account once, which reschedules on the new interval.
      if (next.usagePollIntervalSec !== prev.usagePollIntervalSec) void poller.refresh().catch(() => {});
      // Automatic switching turned back on: threads waiting on their own account may move now.
      if (next.autoSwitchAccounts && !prev.autoSwitchAccounts) void session.reevaluate();
      // A new Codex executable override: detect the engine again (Accounts card, next Codex spawn).
      if (next.codexPath !== prev.codexPath) void localAuth.recheck('codex', { force: true }).catch(() => {});
    },
    // Settings > Codex 실행 파일 경로: only a runnable `codex-cli` at or above the minimum version is stored.
    checkCodexPath: async (path) => {
      const checked = await agentBinaries.checkCodexPath(path);
      return checked.ok ? null : checked.error;
    },
  });

  poller.start();
  await scheduler.load().catch((err: unknown) => console.error('[deltax] schedules could not be loaded', err));
  scheduler.start();
  powerMonitor.on('resume', () => void scheduler.tick());
  // One detection at startup, in the background (the window does not wait); includes the Hermes initialize probe.
  void localAuth.recheck(undefined, { force: true }).catch((err: unknown) => console.error('[deltax] agent detection failed', err));

  return {
    broadcaster,
    async dispose() {
      poller.stop();
      notesAbort.abort();
      notesWatcher.dispose();
      agentUsage.dispose();
      scheduler.stop();
      await scheduler.flush().catch((err: unknown) => console.error('[deltax] schedule flush failed', err));
      await accountPool.cancelAllLogins().catch((err: unknown) => console.error('[deltax] login cancel failed', err));
      await session.dispose().catch((err: unknown) => console.error('[deltax] session dispose failed', err));
      ptyManager.killAll();
      unregisterIpc();
      await store.flush().catch((err: unknown) => console.error('[deltax] store flush failed', err));
    },
    async forceStop() {
      notesAbort.abort();
      session.abortAll();
      ptyManager.killAll();
      await Promise.race([
        store.flush().catch((err: unknown) => console.error('[deltax] store flush failed', err)),
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
  // Role items get explicit labels: macOS would otherwise name them in the OS language, not the app's.
  const name = app.name;
  return Menu.buildFromTemplate([
    {
      label: name,
      submenu: [
        { role: 'about', label: t('menu.about', { app: name }) },
        { type: 'separator' },
        { label: t('menu.settings'), accelerator: 'CmdOrCtrl+,', click: () => broadcaster.emit('ui:openSettings', undefined) },
        { type: 'separator' },
        { role: 'services', label: t('menu.services') },
        { type: 'separator' },
        { role: 'hide', label: t('menu.hide', { app: name }) },
        { role: 'hideOthers', label: t('menu.hideOthers') },
        { role: 'unhide', label: t('menu.showAll') },
        { type: 'separator' },
        { role: 'quit', label: t('menu.quit', { app: name }) },
      ],
    },
    {
      label: t('menu.file'),
      submenu: [
        { label: t('menu.newChat'), accelerator: 'CmdOrCtrl+N', click: () => broadcaster.emit('ui:newThread', undefined) },
        {
          label: t('menu.newTaskStart'),
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => broadcaster.emit('ui:newTaskStart', undefined),
        },
        { type: 'separator' },
        { role: 'close', label: t('menu.closeWindow') },
      ],
    },
    {
      label: t('menu.edit'),
      submenu: [
        { role: 'undo', label: t('menu.undo') },
        { role: 'redo', label: t('menu.redo') },
        { type: 'separator' },
        { role: 'cut', label: t('menu.cut') },
        { role: 'copy', label: t('menu.copy') },
        { role: 'paste', label: t('menu.paste') },
        { role: 'pasteAndMatchStyle', label: t('menu.pasteAndMatchStyle') },
        { role: 'delete', label: t('menu.delete') },
        { role: 'selectAll', label: t('menu.selectAll') },
      ],
    },
    {
      label: t('menu.view'),
      submenu: [
        {
          label: t('menu.toggleSidebar'),
          accelerator: 'CmdOrCtrl+B',
          click: () => broadcaster.emit('ui:toggleSidebar', undefined),
        },
        {
          label: t('menu.toggleTerminal'),
          accelerator: 'CmdOrCtrl+J',
          click: () => broadcaster.emit('ui:toggleTerminal', undefined),
        },
        {
          label: t('menu.toggleChanges'),
          accelerator: 'CmdOrCtrl+Shift+D',
          click: () => broadcaster.emit('ui:toggleChanges', undefined),
        },
        {
          label: t('menu.commandPalette'),
          accelerator: 'CmdOrCtrl+K',
          click: () => broadcaster.emit('ui:commandPalette', undefined),
        },
        { type: 'separator' },
        { role: 'reload', label: t('menu.reload') },
        // DevTools only in development builds (L3).
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools', label: t('menu.toggleDevTools') } as const]),
        { type: 'separator' },
        { role: 'resetZoom', label: t('menu.resetZoom') },
        { role: 'zoomIn', label: t('menu.zoomIn') },
        { role: 'zoomOut', label: t('menu.zoomOut') },
        { type: 'separator' },
        { role: 'togglefullscreen', label: t('menu.toggleFullScreen') },
      ],
    },
    {
      role: 'windowMenu',
      label: t('menu.window'),
      submenu: [
        { role: 'minimize', label: t('menu.minimize') },
        { role: 'zoom', label: t('menu.zoom') },
        { type: 'separator' },
        { role: 'front', label: t('menu.bringAllToFront') },
      ],
    },
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
  // Dark native theme + the hopecode-theme:// scheme (registered before ready, served once ready).
  setupTheme();
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
    // Until settings load, main speaks the system language (the start failure dialog included).
    applyMainLanguage('system');
    try {
      services = await startServices();
    } catch (err) {
      console.error('[deltax] failed to start services', err);
      if (!headless) dialog.showErrorBox(t('main.startFailed'), String(err));
      app.exit(1);
      return;
    }
    if (headless) hideFromDock();
    const broadcaster = services.broadcaster;
    Menu.setApplicationMenu(buildMenu(broadcaster));
    // Labels are built in the current language: a switch in settings rebuilds the whole menu.
    onLanguageChange(() => Menu.setApplicationMenu(buildMenu(broadcaster)));
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
      .catch((err: unknown) => console.error('[deltax] dispose failed', err))
      .then(() => 'done' as const);
    void Promise.race([disposed, timedOut]).then(async (result) => {
      clearTimeout(timer);
      if (result === 'done') {
        app.quit();
        return;
      }
      console.error(`[deltax] dispose exceeded ${QUIT_DISPOSE_TIMEOUT_MS}ms; forcing exit`);
      await svc.forceStop().catch((err: unknown) => console.error('[deltax] force stop failed', err));
      app.exit(0);
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
