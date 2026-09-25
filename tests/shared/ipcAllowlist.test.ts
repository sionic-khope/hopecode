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
import type { Account, PermissionRequest, PersistedState, PoolSnapshot, Project, Thread } from '../../src/shared/types';
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
    title: 'Test thread',
    cwd: '/tmp/project',
    model: 'default',
    resolvedModel: null,
    permissionMode: 'default',
    pinnedAccountId: null,
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
    },
    broadcaster: {
      emit(channel, payload) {
        emitted.push([channel, payload]);
      },
    },
    appVersion: '0.0.0-test',
    isTrustedSender: (url) => url === APP_URL,
    syncTranscript: async () => ({ found: true, copied: [] }),
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
      dialogs: { pickProjectFolder: async () => null, confirmTrustProject: confirm, confirmBypassPermissions: async () => true },
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
      dialogs: { pickProjectFolder: async () => null, confirmTrustProject: async () => 'trust', confirmBypassPermissions: async () => confirm },
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
      expect(res.error).toMatch(/another account/);
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
