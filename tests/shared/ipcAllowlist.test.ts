import { describe, expect, it, vi, beforeEach } from 'vitest';
import { EVENT_CHANNELS, INVOKE_CHANNELS, isEventChannel, isInvokeChannel } from '../../src/shared/ipc';
import {
  registerIpc,
  UntrustedSenderError,
  type IpcEventLike,
  type IpcMainLike,
  type RegisterIpcServices,
} from '../../src/main/ipc/registerIpc';
import { createBroadcaster, type BroadcastTarget } from '../../src/main/ipc/broadcaster';
import { InvalidIpcRequestError } from '../../src/main/ipc/guards';
import { mentionPath } from '../../src/main/ipc/registerIpc';
import type { Account, PermissionRequest, PersistedState, PoolSnapshot, Project, Thread, ThreadStartResult } from '../../src/shared/types';
import { DEFAULT_SETTINGS } from '../../src/shared/constants';

// ---------------------------------------------------------------------------
// Core allowlist predicates (no Electron involved)
// ---------------------------------------------------------------------------

describe('isInvokeChannel / isEventChannel', () => {
  it('accepts every channel listed in INVOKE_CHANNELS / EVENT_CHANNELS', () => {
    for (const ch of INVOKE_CHANNELS) expect(isInvokeChannel(ch)).toBe(true);
    for (const ch of EVENT_CHANNELS) expect(isEventChannel(ch)).toBe(true);
  });

  it('rejects channels outside the allowlist', () => {
    expect(isInvokeChannel('evil:channel')).toBe(false);
    expect(isInvokeChannel('thread:updated')).toBe(false); // event channel, not invoke
    expect(isEventChannel('chat:send')).toBe(false); // invoke channel, not event
    expect(isEventChannel('__proto__')).toBe(false);
    expect(isInvokeChannel(123)).toBe(false);
    expect(isInvokeChannel(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// preload allowlist enforcement (electron mocked; no real Electron runtime)
// ---------------------------------------------------------------------------

describe('preload window.hopecode allowlist', () => {
  it('rejects invoke() on a disallowed channel and never reaches ipcRenderer', async () => {
    vi.resetModules();
    const ipcRendererInvoke = vi.fn(async (_channel: string, ..._args: unknown[]) => 'ok');
    const ipcRendererOn = vi.fn();
    const ipcRendererRemoveListener = vi.fn();
    let exposedApi: any;

    vi.doMock('electron', () => ({
      contextBridge: { exposeInMainWorld: (_key: string, api: unknown) => (exposedApi = api) },
      ipcRenderer: { invoke: ipcRendererInvoke, on: ipcRendererOn, removeListener: ipcRendererRemoveListener },
    }));

    await import('../../src/preload/index');

    await expect(exposedApi.invoke('evil:channel')).rejects.toThrow(/not allowed/);
    expect(ipcRendererInvoke).not.toHaveBeenCalled();

    await exposedApi.invoke('app:bootstrap');
    expect(ipcRendererInvoke).toHaveBeenCalledWith('app:bootstrap');

    expect(() => exposedApi.on('evil:event', () => {})).toThrow(/not allowed/);
    expect(ipcRendererOn).not.toHaveBeenCalled();

    const off = exposedApi.on('thread:updated', () => {});
    expect(ipcRendererOn).toHaveBeenCalledWith('thread:updated', expect.any(Function));
    off();
    expect(ipcRendererRemoveListener).toHaveBeenCalledWith('thread:updated', expect.any(Function));

    vi.doUnmock('electron');
  });
});

// ---------------------------------------------------------------------------
// registerIpc: only allowlisted channels ever get a handler
// ---------------------------------------------------------------------------

const APP_URL = 'file:///app/out/renderer/index.html';

class FakeIpcMain implements IpcMainLike {
  handlers = new Map<string, (event: IpcEventLike, req: unknown) => unknown>();
  handle(channel: string, listener: (event: IpcEventLike, req: unknown) => unknown): void {
    this.handlers.set(channel, listener);
  }
  removeHandler(channel: string): void {
    this.handlers.delete(channel);
  }
  invoke(channel: string, req?: unknown, senderUrl: string = APP_URL): unknown {
    const h = this.handlers.get(channel);
    if (!h) throw new Error(`no handler registered for channel: ${channel}`);
    return h({ senderFrame: { url: senderUrl } }, req);
  }
}

function makeThread(overrides: Partial<Thread> = {}): Thread {
  const now = Date.now();
  return {
    id: 't1',
    projectId: 'p1',
    agent: 'claude-code',
    title: 'Test thread',
    cwd: '/tmp/project',
    model: 'default',
    resolvedModel: null,
    permissionMode: 'default',
    effort: null,
    pinnedAccountId: null,
    pinned: false,
    archived: false,
    lastAccountId: null,
    activeAccountId: null,
    sdkSessionId: null,
    status: 'idle',
    waitingUntil: null,
    pendingPrompt: null,
    sessionStartedAt: null,
    ctxPercent: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: 'a1',
    alias: 'Work',
    color: '#000',
    email: null,
    plan: null,
    configDir: '/tmp/accounts/a1',
    priority: 0,
    enabled: true,
    createdAt: Date.now(),
    ...overrides,
  };
}

function makeFakeServices(overrides: Partial<RegisterIpcServices> = {}): { services: RegisterIpcServices; emitted: [string, unknown][] } {
  const state: PersistedState = { version: 1, projects: [], threads: [makeThread()], accounts: [], settings: DEFAULT_SETTINGS };
  const emitted: [string, unknown][] = [];

  const store: RegisterIpcServices['store'] = {
    async load() {
      return state;
    },
    get() {
      return state;
    },
    update(mutator) {
      mutator(state);
    },
    getThread(threadId) {
      return state.threads.find((t) => t.id === threadId);
    },
    patchThread(threadId, patch) {
      const thread = state.threads.find((t) => t.id === threadId);
      if (!thread) throw new Error('not found');
      Object.assign(thread, patch, { updatedAt: Date.now() });
      return thread;
    },
    async flush() {},
    onChange() {
      return () => {};
    },
  };

  const services: RegisterIpcServices = {
    store,
    threadLog: {
      async append() {},
      async read() {
        return [];
      },
      async remove() {},
    },
    sessionManager: {
      async send() {
        return { accepted: true };
      },
      async interrupt() {},
      async setModel() {},
      async setPermissionMode() {},
      async setEffort() {},
      respondPermission() {},
      async listModels() {
        return [];
      },
      async closeThread() {},
      async closeAccount() {},
      pendingPermissions() {
        return [];
      },
      restore() {},
      reevaluate() {},
      async dispose() {},
      abortAll() {},
    },
    accountPool: {
      list() {
        return [];
      },
      get() {
        return undefined;
      },
      async startLogin() {
        return { loginId: 'l1', accountId: 'a1' };
      },
      loginInput() {},
      async cancelLogin() {},
      async cancelAllLogins() {},
      update(_accountId, patch) {
        return makeAccount(patch);
      },
      reorder() {},
      async remove() {},
      onChange() {
        return () => {};
      },
    },
    usagePoller: {
      start() {},
      stop() {},
      async refresh() {
        return { summary: { avg: { fiveHour: null, sevenDay: null, fable: null }, earliestReset: { fiveHour: null, sevenDay: null, fable: null }, available: 0, total: 0 }, usageById: {}, at: Date.now() } satisfies PoolSnapshot;
      },
      reportRateLimit() {},
      markAuthFailed() {},
      getSnapshot() {
        return { summary: { avg: { fiveHour: null, sevenDay: null, fable: null }, earliestReset: { fiveHour: null, sevenDay: null, fable: null }, available: 0, total: 0 }, usageById: {}, at: 0 };
      },
      getUsage() {
        return undefined;
      },
      onUpdate() {
        return () => {};
      },
    },
    usageHistory: {
      async append() {
        return true;
      },
      async read() {
        return [];
      },
      async compact() {},
      async remove() {},
    },
    ptyManager: {
      open() {
        return { ptyId: 'pty1', replay: '' };
      },
      write() {},
      resize() {},
      kill() {},
      killAll() {},
    },
    worktreeManager: {
      async create() {
        return { cwd: '/tmp/project' };
      },
      async isDirty() {
        return false;
      },
      async remove() {},
    },
    dialogs: {
      async pickProjectFolder() {
        return null;
      },
      async confirmTrustProject() {
        return 'trust';
      },
      async confirmBypassPermissions() {
        return true;
      },
      async pickFiles() {
        return [];
      },
    },
    broadcaster: {
      emit(channel, payload) {
        emitted.push([channel, payload]);
      },
    },
    appVersion: '0.0.0-test',
    isTrustedSender: (url) => url === APP_URL,
    syncTranscript: async () => ({ found: true, copied: [] }),
    gitService: {
      async changes() {
        return { isRepo: false, branch: null, baseBranch: null, files: [], ahead: 0, dirty: false };
      },
      async fileDiff(_cwd, _project, path) {
        return { path, binary: false, hunks: [] };
      },
      async revertFile() {
        return { ok: true };
      },
      async commit() {
        return { ok: true, sha: 'abc' };
      },
      async merge() {
        return { ok: true, into: 'main' };
      },
      async remoteInfo() {
        return { remote: null, remoteUrl: null, branch: null, baseBranch: null, ghAvailable: false };
      },
      async pushAndOpenPr() {
        return { ok: false, error: 'no remote' };
      },
    },
    editorLauncher: {
      async list() {
        return [{ id: 'finder', name: 'Finder' }];
      },
      async open() {},
    },
    appInfo: () => ({ appVersion: '0.0.0-test', cliVersion: null, sdkVersion: null, electronVersion: '', dataDir: '/tmp/data' }),
    async openDataFolder() {},
    quit() {},
    sharedConfig: {
      async status() {
        return { sourceDir: '/tmp/.claude', entries: [] };
      },
      async relink() {
        return { sourceDir: '/tmp/.claude', entries: [] };
      },
    },
    ...overrides,
  };

  return { services, emitted };
}

describe('registerIpc allowlist', () => {
  it('registers exactly the channels in INVOKE_CHANNELS, nothing else', () => {
    const ipcMain = new FakeIpcMain();
    const { services } = makeFakeServices();
    const dispose = registerIpc(ipcMain, services);

    const registered = [...ipcMain.handlers.keys()].sort();
    const expected = [...INVOKE_CHANNELS].sort();
    expect(registered).toEqual(expected);

    dispose();
  });

  it('an unregistered (out-of-allowlist) channel has no handler at all', () => {
    const ipcMain = new FakeIpcMain();
    const { services } = makeFakeServices();
    registerIpc(ipcMain, services);

    expect(() => ipcMain.invoke('evil:channel')).toThrow(/no handler registered/);
  });

  it('dispose() removes every registered handler and unsubscribes account/usage listeners', () => {
    const ipcMain = new FakeIpcMain();
    let accountUnsubbed = false;
    let usageUnsubbed = false;
    const { services } = makeFakeServices({
      accountPool: {
        list: () => [],
        get: () => undefined,
        startLogin: async () => ({ loginId: 'l', accountId: 'a' }),
        loginInput: () => {},
        cancelLogin: async () => {},
        cancelAllLogins: async () => {},
        update: (_id, p) => makeAccount(p),
        reorder: () => {},
        remove: async () => {},
        onChange: () => () => {
          accountUnsubbed = true;
        },
      },
      usagePoller: {
        start: () => {},
        stop: () => {},
        refresh: async () => ({ summary: { avg: { fiveHour: null, sevenDay: null, fable: null }, earliestReset: { fiveHour: null, sevenDay: null, fable: null }, available: 0, total: 0 }, usageById: {}, at: 0 }),
        reportRateLimit: () => {},
        markAuthFailed: () => {},
        getSnapshot: () => ({ summary: { avg: { fiveHour: null, sevenDay: null, fable: null }, earliestReset: { fiveHour: null, sevenDay: null, fable: null }, available: 0, total: 0 }, usageById: {}, at: 0 }),
        getUsage: () => undefined,
        onUpdate: () => () => {
          usageUnsubbed = true;
        },
      },
    });

    const dispose = registerIpc(ipcMain, services);
    expect(ipcMain.handlers.size).toBe(INVOKE_CHANNELS.length);
    dispose();
    expect(ipcMain.handlers.size).toBe(0);
    expect(accountUnsubbed).toBe(true);
    expect(usageUnsubbed).toBe(true);
  });
});

describe('registerIpc handler validation and orchestration', () => {
  it('rejects malformed requests with InvalidIpcRequestError before touching services', async () => {
    const ipcMain = new FakeIpcMain();
    const { services } = makeFakeServices();
    registerIpc(ipcMain, services);

    await expect(ipcMain.invoke('pty:open', { threadId: 't1', cols: 'bad', rows: 24 })).rejects.toBeInstanceOf(InvalidIpcRequestError);
    await expect(ipcMain.invoke('thread:rename', { threadId: 't1' })).rejects.toBeInstanceOf(InvalidIpcRequestError);
    await expect(ipcMain.invoke('permission:respond', { requestId: 'r1', decision: 'maybe' })).rejects.toBeInstanceOf(
      InvalidIpcRequestError,
    );
  });

  it('thread:pinAccount patches the store and broadcasts thread:updated', async () => {
    const ipcMain = new FakeIpcMain();
    const { services, emitted } = makeFakeServices();
    registerIpc(ipcMain, services);

    const result = await ipcMain.invoke('thread:pinAccount', { threadId: 't1', accountId: 'acc-9' });
    expect((result as Thread | undefined)).toBeUndefined(); // void response
    expect(services.store.getThread('t1')?.pinnedAccountId).toBe('acc-9');
    expect(emitted).toContainEqual(['thread:updated', expect.objectContaining({ id: 't1', pinnedAccountId: 'acc-9' })]);
  });

  it('pty:open resolves the thread cwd from the store before delegating to ptyManager', async () => {
    const ipcMain = new FakeIpcMain();
    const opened: unknown[] = [];
    const { services } = makeFakeServices({
      ptyManager: {
        open: (threadId, cwd, cols, rows) => {
          opened.push([threadId, cwd, cols, rows]);
          return { ptyId: 'pty-x', replay: 'hello' };
        },
        write: () => {},
        resize: () => {},
        kill: () => {},
        killAll: () => {},
      },
    });
    registerIpc(ipcMain, services);

    const res = await ipcMain.invoke('pty:open', { threadId: 't1', cols: 80, rows: 24 });
    expect(res).toEqual({ ptyId: 'pty-x', replay: 'hello' });
    expect(opened).toEqual([['t1', '/tmp/project', 80, 24]]);
  });

  it('pty:open rejects an unknown threadId', async () => {
    const ipcMain = new FakeIpcMain();
    const { services } = makeFakeServices();
    registerIpc(ipcMain, services);
    await expect(ipcMain.invoke('pty:open', { threadId: 'missing', cols: 80, rows: 24 })).rejects.toBeInstanceOf(
      InvalidIpcRequestError,
    );
  });

  it('account:update validates patch field types', async () => {
    const ipcMain = new FakeIpcMain();
    const { services } = makeFakeServices();
    registerIpc(ipcMain, services);

    await expect(ipcMain.invoke('account:update', { accountId: 'a1', patch: { enabled: 'yes' } })).rejects.toBeInstanceOf(
      InvalidIpcRequestError,
    );
    const account = await ipcMain.invoke('account:update', { accountId: 'a1', patch: { alias: 'New' } });
    expect(account).toMatchObject({ alias: 'New' });
  });

  it('account:updated / usage:updated broadcasts are forwarded from the injected services', () => {
    const ipcMain = new FakeIpcMain();
    let accountCb: ((a: Account[]) => void) | undefined;
    let usageCb: ((p: PoolSnapshot) => void) | undefined;
    const { services, emitted } = makeFakeServices({
      accountPool: {
        list: () => [],
        get: () => undefined,
        startLogin: async () => ({ loginId: 'l', accountId: 'a' }),
        loginInput: () => {},
        cancelLogin: async () => {},
        cancelAllLogins: async () => {},
        update: (_id, p) => makeAccount(p),
        reorder: () => {},
        remove: async () => {},
        onChange: (cb) => {
          accountCb = cb;
          return () => {};
        },
      },
      usagePoller: {
        start: () => {},
        stop: () => {},
        refresh: async () => ({ summary: { avg: { fiveHour: null, sevenDay: null, fable: null }, earliestReset: { fiveHour: null, sevenDay: null, fable: null }, available: 0, total: 0 }, usageById: {}, at: 0 }),
        reportRateLimit: () => {},
        markAuthFailed: () => {},
        getSnapshot: () => ({ summary: { avg: { fiveHour: null, sevenDay: null, fable: null }, earliestReset: { fiveHour: null, sevenDay: null, fable: null }, available: 0, total: 0 }, usageById: {}, at: 0 }),
        getUsage: () => undefined,
        onUpdate: (cb) => {
          usageCb = cb;
          return () => {};
        },
      },
    });
    registerIpc(ipcMain, services);

    const accounts = [makeAccount()];
    accountCb?.(accounts);
    expect(emitted).toContainEqual(['account:updated', accounts]);

    const snapshot: PoolSnapshot = { summary: { avg: { fiveHour: 10, sevenDay: 5, fable: 0 }, earliestReset: { fiveHour: null, sevenDay: null, fable: null }, available: 1, total: 1 }, usageById: {}, at: 123 };
    usageCb?.(snapshot);
    expect(emitted).toContainEqual(['usage:updated', snapshot]);
  });
});

describe('registerIpc review fixes', () => {
  function project(over: Partial<Project> = {}): Project {
    return { id: 'p1', name: 'proj', path: '/tmp/proj', trusted: false, createdAt: 0, ...over };
  }

  it('(M1) refuses invokes whose sender frame is not the app', async () => {
    const ipcMain = new FakeIpcMain();
    const { services } = makeFakeServices();
    registerIpc(ipcMain, services);
    expect(() => ipcMain.invoke('app:bootstrap', undefined, 'https://evil.example/')).toThrow(UntrustedSenderError);
    const h = ipcMain.handlers.get('app:bootstrap')!;
    expect(() => h({ senderFrame: null }, undefined)).toThrow(UntrustedSenderError);
    await expect(ipcMain.invoke('app:bootstrap')).resolves.toBeDefined();
  });

  it('(contract 2) bootstrap carries pending permission requests', async () => {
    const ipcMain = new FakeIpcMain();
    const pending: PermissionRequest[] = [
      { requestId: 'r1', threadId: 't1', toolUseId: 'tu', toolName: 'Bash', input: {}, hasSessionSuggestion: false },
    ];
    const { services } = makeFakeServices();
    services.sessionManager.pendingPermissions = () => pending;
    registerIpc(ipcMain, services);
    const payload = (await ipcMain.invoke('app:bootstrap')) as { pendingPermissions: PermissionRequest[] };
    expect(payload.pendingPermissions).toEqual(pending);
  });

  it('(contract 1) project:add asks for trust; Cancel adds nothing', async () => {
    const ipcMain = new FakeIpcMain();
    const answers = ['dont-trust', 'cancel', 'trust'] as const;
    let n = 0;
    let picked = 0;
    const { services } = makeFakeServices({
      dialogs: {
        pickProjectFolder: async () => `/tmp/proj${++picked}`,
        confirmTrustProject: async () => answers[n++]!,
        confirmBypassPermissions: async () => true,
        pickFiles: async () => [],
      },
    });
    registerIpc(ipcMain, services);
    expect(await ipcMain.invoke('project:add')).toMatchObject({ path: '/tmp/proj1', trusted: false });
    expect(await ipcMain.invoke('project:add')).toBeNull();
    expect(await ipcMain.invoke('project:add')).toMatchObject({ path: '/tmp/proj3', trusted: true });
    expect(services.store.get().projects.map((p) => [p.path, p.trusted])).toEqual([
      ['/tmp/proj1', false],
      ['/tmp/proj3', true],
    ]);
  });

  it('(contract 1) project:setTrusted confirms natively before granting trust; revoking needs no dialog', async () => {
    const ipcMain = new FakeIpcMain();
    const confirm = vi.fn(async () => 'dont-trust' as const);
    const { services } = makeFakeServices({
      dialogs: { pickProjectFolder: async () => null, confirmTrustProject: confirm, confirmBypassPermissions: async () => true, pickFiles: async () => [] },
    });
    services.store.get().projects.push(project());
    registerIpc(ipcMain, services);

    expect(await ipcMain.invoke('project:setTrusted', { projectId: 'p1', trusted: true })).toMatchObject({ trusted: false });
    confirm.mockResolvedValueOnce('trust' as never);
    expect(await ipcMain.invoke('project:setTrusted', { projectId: 'p1', trusted: true })).toMatchObject({ trusted: true });
    expect(services.store.get().projects[0]!.trusted).toBe(true);
    expect(await ipcMain.invoke('project:setTrusted', { projectId: 'p1', trusted: false })).toMatchObject({ trusted: false });
    expect(confirm).toHaveBeenCalledTimes(2);
    await expect(ipcMain.invoke('project:setTrusted', { projectId: 'nope', trusted: true })).rejects.toBeInstanceOf(
      InvalidIpcRequestError,
    );
  });

  it('(contract 4) thread:create never starts in bypassPermissions', async () => {
    const ipcMain = new FakeIpcMain();
    const { services } = makeFakeServices();
    services.store.get().projects.push(project());
    registerIpc(ipcMain, services);
    const t = (await ipcMain.invoke('thread:create', { projectId: 'p1', permissionMode: 'bypassPermissions' })) as Thread;
    expect(t.permissionMode).toBe('default');
    const t2 = (await ipcMain.invoke('thread:create', { projectId: 'p1', permissionMode: 'plan' })) as Thread;
    expect(t2.permissionMode).toBe('plan');
  });

  it('(contract 4) bypassPermissions needs the native confirm; the applied mode is always broadcast', async () => {
    const ipcMain = new FakeIpcMain();
    let confirm = false;
    const applied: string[] = [];
    const { services, emitted } = makeFakeServices({
      dialogs: { pickProjectFolder: async () => null, confirmTrustProject: async () => 'trust', confirmBypassPermissions: async () => confirm, pickFiles: async () => [] },
    });
    services.sessionManager.setPermissionMode = async (threadId, mode) => {
      applied.push(mode);
      services.store.patchThread(threadId, { permissionMode: mode });
    };
    registerIpc(ipcMain, services);

    await ipcMain.invoke('thread:setPermissionMode', { threadId: 't1', mode: 'bypassPermissions' });
    expect(applied).toEqual([]);
    expect(emitted.at(-1)).toEqual(['thread:updated', expect.objectContaining({ id: 't1', permissionMode: 'default' })]);

    confirm = true;
    await ipcMain.invoke('thread:setPermissionMode', { threadId: 't1', mode: 'bypassPermissions' });
    expect(applied).toEqual(['bypassPermissions']);
    expect(emitted.at(-1)).toEqual(['thread:updated', expect.objectContaining({ permissionMode: 'bypassPermissions' })]);

    confirm = false;
    await ipcMain.invoke('thread:setPermissionMode', { threadId: 't1', mode: 'plan' });
    expect(applied).toEqual(['bypassPermissions', 'plan']);
  });

  it('(L10) thread:delete with a dirty worktree deletes nothing until force is sent', async () => {
    const ipcMain = new FakeIpcMain();
    const removed: boolean[] = [];
    const closed: string[] = [];
    const { services } = makeFakeServices({
      worktreeManager: {
        create: async () => ({ cwd: '/tmp/project' }),
        isDirty: async () => true,
        remove: async (_p, _w, opts) => void removed.push(opts.force),
      },
    });
    services.sessionManager.closeThread = async (id) => void closed.push(id);
    services.store.get().projects.push(project());
    services.store.patchThread('t1', { projectId: 'p1', worktree: { path: '/wt/t1', branch: 'hopecode/t1' } });
    registerIpc(ipcMain, services);

    expect(await ipcMain.invoke('thread:delete', { threadId: 't1', removeWorktree: true })).toEqual({
      ok: false,
      reason: 'worktree-dirty',
    });
    expect(services.store.getThread('t1')).toBeDefined();
    expect(closed).toEqual([]);

    expect(await ipcMain.invoke('thread:delete', { threadId: 't1', removeWorktree: true, force: true })).toEqual({ ok: true });
    expect(removed).toEqual([true]);
    expect(services.store.getThread('t1')).toBeUndefined();
  });

  it('(M2) chat:history requires a known thread; usage:history a known account and a bounded range', async () => {
    const ipcMain = new FakeIpcMain();
    const reads: number[] = [];
    const { services } = makeFakeServices({
      usageHistory: {
        append: async () => true,
        read: async (_id, rangeMs) => (reads.push(rangeMs), []),
        compact: async () => {},
        remove: async () => {},
      },
    });
    services.accountPool.get = (id) => (id === 'a1' ? makeAccount() : undefined);
    registerIpc(ipcMain, services);

    await expect(ipcMain.invoke('chat:history', { threadId: '../x' })).rejects.toBeInstanceOf(InvalidIpcRequestError);
    await expect(ipcMain.invoke('chat:history', { threadId: 't1' })).resolves.toEqual([]);
    await expect(ipcMain.invoke('usage:history', { accountId: '../x', rangeMs: 1000 })).rejects.toBeInstanceOf(
      InvalidIpcRequestError,
    );
    await expect(ipcMain.invoke('usage:history', { accountId: 'a1', rangeMs: -5 })).rejects.toBeInstanceOf(
      InvalidIpcRequestError,
    );
    await ipcMain.invoke('usage:history', { accountId: 'a1', rangeMs: 10 ** 12 });
    expect(reads).toEqual([14 * 24 * 60 * 60 * 1000]);
  });

  describe('(contract 5) account:remove', () => {
    function setupRemove(accounts: Account[], opts: { syncFails?: boolean } = {}) {
      const ipcMain = new FakeIpcMain();
      const order: string[] = [];
      const { services, emitted } = makeFakeServices({
        syncTranscript: async (sid, from, to) => {
          order.push(`sync:${sid}:${from}->${to}`);
          if (opts.syncFails) throw new Error('EACCES: permission denied');
          return { found: true, copied: [] };
        },
      });
      services.accountPool.list = () => accounts;
      services.accountPool.get = (id) => accounts.find((a) => a.id === id);
      services.accountPool.update = (id, patch) => {
        order.push(`update:${id}:${JSON.stringify(patch)}`);
        const a = accounts.find((x) => x.id === id)!;
        Object.assign(a, patch);
        return a;
      };
      services.accountPool.remove = async (id, del) => void order.push(`remove:${id}:${del}`);
      services.sessionManager.closeAccount = async (id) => void order.push(`close:${id}`);
      registerIpc(ipcMain, services);
      return { ipcMain, services, order, emitted };
    }

    it('closes Queries, hands transcripts to another enabled account, then deletes', async () => {
      const a = makeAccount({ id: 'a1', configDir: '/acc/a1' });
      const b = makeAccount({ id: 'b1', configDir: '/acc/b1', enabled: true });
      const { ipcMain, services, order } = setupRemove([a, b]);
      services.store.patchThread('t1', { lastAccountId: 'a1', activeAccountId: 'a1', pinnedAccountId: 'a1', sdkSessionId: 'sid-1' });

      expect(await ipcMain.invoke('account:remove', { accountId: 'a1', deleteConfigDir: true })).toEqual({ ok: true });
      expect(order).toEqual([
        'update:a1:{"enabled":false}',
        'close:a1',
        'sync:sid-1:/acc/a1->/acc/b1',
        'remove:a1:true',
      ]);
      expect(services.store.getThread('t1')).toMatchObject({ lastAccountId: 'b1', activeAccountId: null, pinnedAccountId: null });
    });

    it('is refused when threads depend on the account and no other enabled account remains', async () => {
      const a = makeAccount({ id: 'a1' });
      const b = makeAccount({ id: 'b1', enabled: false });
      const { ipcMain, services, order } = setupRemove([a, b]);
      services.store.patchThread('t1', { lastAccountId: 'a1', sdkSessionId: 'sid-1' });
      const res = (await ipcMain.invoke('account:remove', { accountId: 'a1', deleteConfigDir: true })) as {
        ok: boolean;
        error?: string;
      };
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/다른 계정/);
      expect(order).toEqual([]);
    });

    it('(review 2) a failed transcript handoff aborts the removal and re-enables the account', async () => {
      const a = makeAccount({ id: 'a1', configDir: '/acc/a1' });
      const b = makeAccount({ id: 'b1', configDir: '/acc/b1' });
      const { ipcMain, services, order } = setupRemove([a, b], { syncFails: true });
      const logSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      services.store.patchThread('t1', { lastAccountId: 'a1', sdkSessionId: 'sid-1' });

      const res = (await ipcMain.invoke('account:remove', { accountId: 'a1', deleteConfigDir: true })) as {
        ok: boolean;
        error?: string;
      };
      logSpy.mockRestore();
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/EACCES/);
      expect(order).not.toContain('remove:a1:true');
      expect(order.at(-1)).toBe('update:a1:{"enabled":true}');
      expect(a.enabled).toBe(true);
      expect(services.store.getThread('t1')).toMatchObject({ lastAccountId: 'a1' });
    });

    it('removes the last account when no thread depends on it', async () => {
      const { ipcMain, order } = setupRemove([makeAccount({ id: 'a1' })]);
      expect(await ipcMain.invoke('account:remove', { accountId: 'a1', deleteConfigDir: false })).toEqual({ ok: true });
      expect(order).toContain('remove:a1:false');
    });
  });
});

// ---------------------------------------------------------------------------
// Draft -> thread:start, pin / archive / effort, file mentions
// ---------------------------------------------------------------------------

describe('thread:start', () => {
  function project(over: Partial<Project> = {}): Project {
    return { id: 'p1', name: 'proj', path: '/tmp/proj', trusted: true, createdAt: 0, ...over };
  }

  function setup(opts: { sendResult?: { accepted: boolean; reason?: 'waiting' | 'no-accounts' | 'busy' | 'auth' }; bypassOk?: boolean } = {}) {
    const ipcMain = new FakeIpcMain();
    const created: string[] = [];
    const removed: string[] = [];
    const sent: [string, string][] = [];
    const bypassAsked: number[] = [];
    const { services, emitted } = makeFakeServices({
      worktreeManager: {
        create: async (_path, shortId) => {
          created.push(shortId);
          return { cwd: `/wt/${shortId}`, worktree: { path: `/wt/${shortId}`, branch: `hopecode/${shortId}` } };
        },
        isDirty: async () => false,
        remove: async (_p, w) => void removed.push(w.path),
      },
      dialogs: {
        pickProjectFolder: async () => null,
        confirmTrustProject: async () => 'trust',
        confirmBypassPermissions: async () => {
          bypassAsked.push(1);
          return opts.bypassOk ?? false;
        },
        pickFiles: async () => [],
      },
    });
    services.store.get().threads.length = 0;
    services.store.get().projects.push(project());
    services.sessionManager.send = async (threadId, text) => {
      sent.push([threadId, text]);
      return opts.sendResult ?? { accepted: true };
    };
    registerIpc(ipcMain, services);
    return { ipcMain, services, emitted, created, removed, sent, bypassAsked };
  }

  it('creates the thread + worktree, titles it from the first message and sends it', async () => {
    const { ipcMain, services, emitted, created, sent } = setup();
    const text = '  README의 인사말을 바꾸고 테스트를 추가해 주세요. 그리고 CHANGELOG도 업데이트해 주세요\n두 번째 줄';
    const res = (await ipcMain.invoke('thread:start', {
      projectId: 'p1',
      text,
      model: 'sonnet',
      permissionMode: 'plan',
      effort: 'max',
    })) as ThreadStartResult;
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(created).toHaveLength(1);
    expect(res.thread).toMatchObject({
      projectId: 'p1',
      model: 'sonnet',
      permissionMode: 'plan',
      effort: 'max',
      pinned: false,
      archived: false,
      cwd: `/wt/${created[0]}`,
      worktree: { branch: `hopecode/${created[0]}` },
    });
    expect(res.thread.title).toBe('README의 인사말을 바꾸고 테스트를 추가해 주세요. 그리고 CHANG…');
    expect(sent).toEqual([[res.thread.id, text]]);
    expect(services.store.get().threads.map((t) => t.id)).toEqual([res.thread.id]);
    expect(emitted.filter(([ch]) => ch === 'thread:updated')).toHaveLength(1);
  });

  it('rolls everything back when the first send is refused', async () => {
    const { ipcMain, services, emitted, created, removed } = setup({ sendResult: { accepted: false, reason: 'no-accounts' } });
    const res = await ipcMain.invoke('thread:start', { projectId: 'p1', text: 'hello' });
    expect(res).toEqual({ ok: false, reason: 'no-accounts' });
    expect(services.store.get().threads).toEqual([]);
    expect(removed).toEqual([`/wt/${created[0]}`]);
    expect(emitted.filter(([ch]) => ch === 'thread:updated')).toEqual([]);
  });

  it('keeps a thread whose first message is queued behind the pool reset', async () => {
    const { ipcMain, services } = setup({ sendResult: { accepted: true, reason: 'waiting' } });
    const res = (await ipcMain.invoke('thread:start', { projectId: 'p1', text: 'hello' })) as ThreadStartResult;
    expect(res).toMatchObject({ ok: true, send: { accepted: true, reason: 'waiting' } });
    expect(services.store.get().threads).toHaveLength(1);
  });

  it('grants bypassPermissions only through the native confirm', async () => {
    const declined = setup({ bypassOk: false });
    const r1 = (await declined.ipcMain.invoke('thread:start', {
      projectId: 'p1',
      text: 'x',
      permissionMode: 'bypassPermissions',
    })) as ThreadStartResult;
    expect(declined.bypassAsked).toHaveLength(1);
    expect(r1.ok && r1.thread.permissionMode).toBe('default');

    const accepted = setup({ bypassOk: true });
    const r2 = (await accepted.ipcMain.invoke('thread:start', {
      projectId: 'p1',
      text: 'x',
      permissionMode: 'bypassPermissions',
    })) as ThreadStartResult;
    expect(r2.ok && r2.thread.permissionMode).toBe('bypassPermissions');
  });

  it('validates the request before creating anything', async () => {
    const { ipcMain, created, sent } = setup();
    const bad: unknown[] = [
      undefined,
      { text: 'x' },
      { projectId: 'p1' },
      { projectId: 'p1', text: '   ' },
      { projectId: 'p1', text: 'x', permissionMode: 'yolo' },
      { projectId: 'p1', text: 'x', effort: 'extreme' },
      { projectId: 'p1', text: 'x', model: 42 },
      { projectId: 'p1', text: 'x', pinnedAccountId: 'ghost' },
      { projectId: 'nope', text: 'x' },
      // A raw folder path is not accepted: folders only enter through project:add (dialog + trust question).
      { projectPath: '/etc', text: 'x' },
    ];
    for (const req of bad) {
      await expect(ipcMain.invoke('thread:start', req)).rejects.toBeInstanceOf(InvalidIpcRequestError);
    }
    expect(created).toEqual([]);
    expect(sent).toEqual([]);
  });

  it('refuses an untrusted sender', () => {
    const { ipcMain } = setup();
    expect(() => ipcMain.invoke('thread:start', { projectId: 'p1', text: 'x' }, 'https://evil.example/')).toThrow(
      UntrustedSenderError,
    );
  });
});

describe('thread pin / archive / effort', () => {
  it('setPinned and setArchived persist and broadcast; archiving unpins', async () => {
    const ipcMain = new FakeIpcMain();
    const { services, emitted } = makeFakeServices();
    registerIpc(ipcMain, services);

    await ipcMain.invoke('thread:setPinned', { threadId: 't1', pinned: true });
    expect(services.store.getThread('t1')).toMatchObject({ pinned: true, archived: false });
    expect(emitted.at(-1)).toEqual(['thread:updated', expect.objectContaining({ id: 't1', pinned: true })]);

    await ipcMain.invoke('thread:setArchived', { threadId: 't1', archived: true });
    expect(services.store.getThread('t1')).toMatchObject({ pinned: false, archived: true });
    await ipcMain.invoke('thread:setArchived', { threadId: 't1', archived: false });
    expect(services.store.getThread('t1')).toMatchObject({ pinned: false, archived: false });

    await expect(ipcMain.invoke('thread:setPinned', { threadId: 't1', pinned: 'yes' })).rejects.toBeInstanceOf(InvalidIpcRequestError);
    await expect(ipcMain.invoke('thread:setArchived', { threadId: 'ghost', archived: true })).rejects.toBeInstanceOf(
      InvalidIpcRequestError,
    );
  });

  it('setEffort goes through the session manager and reports the applied value', async () => {
    const ipcMain = new FakeIpcMain();
    const { services, emitted } = makeFakeServices();
    const applied: (string | null)[] = [];
    services.sessionManager.setEffort = async (threadId, effort) => {
      applied.push(effort);
      services.store.patchThread(threadId, { effort });
    };
    registerIpc(ipcMain, services);
    await ipcMain.invoke('thread:setEffort', { threadId: 't1', effort: 'low' });
    await ipcMain.invoke('thread:setEffort', { threadId: 't1', effort: null });
    expect(applied).toEqual(['low', null]);
    expect(emitted.at(-1)).toEqual(['thread:updated', expect.objectContaining({ effort: null })]);
    await expect(ipcMain.invoke('thread:setEffort', { threadId: 't1', effort: 'turbo' })).rejects.toBeInstanceOf(
      InvalidIpcRequestError,
    );
  });
});

describe('dialog:pickFiles', () => {
  it('turns picked files into @ mentions relative to the thread cwd', async () => {
    const ipcMain = new FakeIpcMain();
    const bases: string[] = [];
    const { services } = makeFakeServices();
    services.dialogs.pickFiles = async (base) => {
      bases.push(base);
      return [`${base}/src/app.ts`, '/other/place/notes.md', `${base}/docs/my file.md`];
    };
    registerIpc(ipcMain, services);
    expect(await ipcMain.invoke('dialog:pickFiles', { threadId: 't1' })).toEqual([
      '@src/app.ts',
      '@/other/place/notes.md',
      '@"docs/my file.md"',
    ]);
    expect(bases).toEqual(['/tmp/project']);
    await expect(ipcMain.invoke('dialog:pickFiles', {})).rejects.toBeInstanceOf(InvalidIpcRequestError);
    await expect(ipcMain.invoke('dialog:pickFiles', { projectId: 'ghost' })).rejects.toBeInstanceOf(InvalidIpcRequestError);
  });

  it('mentionPath keeps paths outside the base absolute', () => {
    expect(mentionPath('/a/b/c.txt', '/a')).toBe('@b/c.txt');
    expect(mentionPath('/ab/c.txt', '/a')).toBe('@/ab/c.txt');
    expect(mentionPath('/a', '/a')).toBe('@/a');
  });
});

// ---------------------------------------------------------------------------
// Broadcaster: only ever sends on allowlisted event channels
// ---------------------------------------------------------------------------

describe('createBroadcaster', () => {
  function makeTarget(): BroadcastTarget & { sent: [string, unknown][] } {
    const sent: [string, unknown][] = [];
    return {
      sent,
      webContents: {
        isDestroyed: () => false,
        send: (channel: string, payload: unknown) => {
          sent.push([channel, payload]);
        },
      },
    } as unknown as BroadcastTarget & { sent: [string, unknown][] };
  }

  let logSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('sends to every non-destroyed target for an allowlisted channel', () => {
    const t1 = makeTarget();
    const t2 = makeTarget();
    const broadcaster = createBroadcaster(() => [t1, t2]);
    broadcaster.emit('thread:updated', makeThread());
    expect(t1.sent).toEqual([['thread:updated', expect.objectContaining({ id: 't1' })]]);
    expect(t2.sent).toEqual([['thread:updated', expect.objectContaining({ id: 't1' })]]);
  });

  it('skips destroyed targets', () => {
    const alive = makeTarget();
    const dead = makeTarget();
    (dead.webContents as { isDestroyed: () => boolean }).isDestroyed = () => true;
    const broadcaster = createBroadcaster(() => [alive, dead]);
    broadcaster.emit('ui:toggleTerminal', undefined);
    expect(alive.sent.length).toBe(1);
    expect(dead.sent.length).toBe(0);
  });

  it('refuses to broadcast a channel outside EVENT_CHANNELS even if forced past the type system', () => {
    const t1 = makeTarget();
    const broadcaster = createBroadcaster(() => [t1]);
    (broadcaster.emit as (channel: string, payload: unknown) => void)('evil:channel', { x: 1 });
    expect(t1.sent).toEqual([]);
    expect(logSpy).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Settings, worktree preference, agents, app / git / editor channels
// ---------------------------------------------------------------------------

describe('settings:update', () => {
  function setup() {
    const ipcMain = new FakeIpcMain();
    const changes: [unknown, unknown][] = [];
    const { services, emitted } = makeFakeServices({ onSettingsChanged: (next, prev) => void changes.push([next, prev]) });
    services.store.get().settings = { ...DEFAULT_SETTINGS };
    registerIpc(ipcMain, services);
    return { ipcMain, services, emitted, changes };
  }

  it('stores a validated patch, reports it to main and broadcasts settings:updated', async () => {
    const { ipcMain, services, emitted, changes } = setup();
    const next = await ipcMain.invoke('settings:update', {
      autoSwitchAccounts: false,
      usagePollIntervalSec: 180,
      useWorktree: false,
      defaultEffort: 'high',
      defaultPermissionMode: 'plan',
      defaultModel: 'claude-fable-5-1',
      idleCloseMinutes: 30,
      notifications: false,
      defaultEditor: 'cursor',
    });
    expect(next).toMatchObject({ autoSwitchAccounts: false, usagePollIntervalSec: 180, useWorktree: false, defaultEffort: 'high' });
    expect(services.store.get().settings).toEqual(next);
    expect(emitted.filter(([ch]) => ch === 'settings:updated').map(([, p]) => p)).toEqual([next]);
    expect(changes).toHaveLength(1);
    expect((changes[0]![1] as typeof DEFAULT_SETTINGS).autoSwitchAccounts).toBe(true);
  });

  it('rejects invalid values and unknown keys without touching the stored settings', async () => {
    const { ipcMain, services } = setup();
    const before = { ...services.store.get().settings };
    for (const bad of [
      { usagePollIntervalSec: 30 },
      { usagePollIntervalSec: 301 },
      { defaultPermissionMode: 'bypassPermissions' },
      { defaultEffort: 'ultra' },
      { useWorktree: 'no' },
      { tosNoticeAcknowledged: true },
      { somethingElse: 1 },
      { defaultEditor: 'emacs' },
      null,
      [],
    ]) {
      await expect(Promise.resolve(ipcMain.invoke('settings:update', bad))).rejects.toThrow(InvalidIpcRequestError);
    }
    expect(services.store.get().settings).toEqual(before);
  });
});

describe('new threads follow the settings (worktree preference, default effort) and carry their agent', () => {
  function setup(settings: Partial<typeof DEFAULT_SETTINGS>) {
    const ipcMain = new FakeIpcMain();
    const created: string[] = [];
    const { services } = makeFakeServices({
      worktreeManager: {
        create: async (_path, shortId) => {
          created.push(shortId);
          return { cwd: `/wt/${shortId}`, worktree: { path: `/wt/${shortId}`, branch: `hopecode/${shortId}` } };
        },
        isDirty: async () => false,
        async remove() {},
      },
    });
    services.store.get().threads.length = 0;
    services.store.get().settings = { ...DEFAULT_SETTINGS, ...settings };
    services.store.get().projects.push({ id: 'p1', name: 'proj', path: '/tmp/proj', trusted: true, createdAt: 0 });
    registerIpc(ipcMain, services);
    return { ipcMain, created };
  }

  it('worktree off: the thread works directly in the project folder (no worktree is created)', async () => {
    const { ipcMain, created } = setup({ useWorktree: false });
    const res = (await ipcMain.invoke('thread:start', { projectId: 'p1', text: 'hello' })) as ThreadStartResult;
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(created).toEqual([]);
    expect(res.thread.cwd).toBe('/tmp/proj');
    expect(res.thread.worktree).toBeUndefined();
  });

  it('worktree on (default): a worktree per thread', async () => {
    const { ipcMain, created } = setup({});
    const res = (await ipcMain.invoke('thread:start', { projectId: 'p1', text: 'hello' })) as ThreadStartResult;
    expect(res.ok && res.thread.cwd).toBe(`/wt/${created[0]}`);
  });

  it('agent defaults to claude-code, is stored as requested, and an unknown agent is refused', async () => {
    const { ipcMain } = setup({});
    const a = (await ipcMain.invoke('thread:start', { projectId: 'p1', text: 'x' })) as ThreadStartResult;
    expect(a.ok && a.thread.agent).toBe('claude-code');
    const b = (await ipcMain.invoke('thread:start', { projectId: 'p1', text: 'y', agent: 'claude-code' })) as ThreadStartResult;
    expect(b.ok && b.thread.agent).toBe('claude-code');
    await expect(Promise.resolve(ipcMain.invoke('thread:start', { projectId: 'p1', text: 'z', agent: 'gpt' }))).rejects.toThrow(
      InvalidIpcRequestError,
    );
  });

  it('thread:create uses the default effort; thread:start keeps an explicit null', async () => {
    const { ipcMain } = setup({ defaultEffort: 'high' });
    const created = (await ipcMain.invoke('thread:create', { projectId: 'p1' })) as Thread;
    expect(created.effort).toBe('high');
    const started = (await ipcMain.invoke('thread:start', { projectId: 'p1', text: 'x', effort: null })) as ThreadStartResult;
    expect(started.ok && started.thread.effort).toBeNull();
  });
});

describe('threads:deleteArchived', () => {
  it('deletes only archived threads, with their worktrees (forced)', async () => {
    const ipcMain = new FakeIpcMain();
    const removed: [string, boolean][] = [];
    const { services } = makeFakeServices({
      worktreeManager: {
        async create() {
          return { cwd: '/x' };
        },
        isDirty: async () => true,
        remove: async (_p, w, o) => void removed.push([w.path, o.force]),
      },
    });
    services.store.get().projects.push({ id: 'p1', name: 'proj', path: '/tmp/proj', trusted: true, createdAt: 0 });
    services.store.get().threads.length = 0;
    services.store.get().threads.push(
      makeThread({ id: 'keep' }),
      makeThread({ id: 'old1', archived: true, worktree: { path: '/wt/old1', branch: 'hopecode/old1' } }),
      makeThread({ id: 'old2', archived: true }),
    );
    registerIpc(ipcMain, services);
    expect(await ipcMain.invoke('threads:deleteArchived')).toEqual({ deleted: 2 });
    expect(services.store.get().threads.map((t) => t.id)).toEqual(['keep']);
    expect(removed).toEqual([['/wt/old1', true]]);
  });
});

describe('editor / git channels only ever act on the thread folder', () => {
  function setup() {
    const ipcMain = new FakeIpcMain();
    const opened: [string, string][] = [];
    const diffs: string[] = [];
    const { services } = makeFakeServices({
      editorLauncher: {
        async list() {
          return [{ id: 'vscode', name: 'Visual Studio Code' }];
        },
        async open(editor, dir) {
          opened.push([editor, dir]);
        },
      },
    });
    services.gitService.fileDiff = async (cwd, _p, path) => {
      diffs.push(`${cwd}:${path}`);
      return { path, binary: false, hunks: [] };
    };
    registerIpc(ipcMain, services);
    return { ipcMain, opened, diffs };
  }

  it('editor:open passes the thread cwd (never a renderer path) and validates the editor id', async () => {
    const { ipcMain, opened } = setup();
    await ipcMain.invoke('editor:open', { threadId: 't1', editor: 'vscode', dir: '/etc' });
    expect(opened).toEqual([['vscode', '/tmp/project']]);
    await expect(Promise.resolve(ipcMain.invoke('editor:open', { threadId: 't1', editor: 'rm -rf' }))).rejects.toThrow(
      InvalidIpcRequestError,
    );
    await expect(Promise.resolve(ipcMain.invoke('editor:open', { threadId: 'nope', editor: 'vscode' }))).rejects.toThrow(
      InvalidIpcRequestError,
    );
  });

  it('git:fileDiff refuses absolute paths before reaching GitService', async () => {
    const { ipcMain, diffs } = setup();
    await ipcMain.invoke('git:fileDiff', { threadId: 't1', path: 'src/a.ts' });
    expect(diffs).toEqual(['/tmp/project:src/a.ts']);
    await expect(Promise.resolve(ipcMain.invoke('git:fileDiff', { threadId: 't1', path: '/etc/passwd' }))).rejects.toThrow(
      InvalidIpcRequestError,
    );
    await expect(Promise.resolve(ipcMain.invoke('git:revertFile', { threadId: 't1', path: '' }))).rejects.toThrow(
      InvalidIpcRequestError,
    );
  });

  it('refuses every new channel from an untrusted sender', async () => {
    const { ipcMain } = setup();
    for (const ch of ['settings:update', 'app:openDataFolder', 'editor:open', 'git:commit', 'git:pushPr', 'threads:deleteArchived']) {
      expect(() => ipcMain.invoke(ch, {}, 'https://evil.example')).toThrow(UntrustedSenderError);
    }
  });
});
