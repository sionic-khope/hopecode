// Store reducer/action tests (plan 8, lane 2C). `../../src/renderer/api` is mocked so this runs
// in plain Node (vitest environment: node) without `window.hopecode` / Electron.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account, ChatItem, PermissionRequest, PoolSnapshot, Project, Thread } from '../../src/shared/types';

const invoke = vi.fn();
const on = vi.fn();

vi.mock('../../src/renderer/api', () => ({ invoke, on }));

// Import after the mock so `appStore.ts` picks up the mocked `invoke`.
const { useAppStore } = await import('../../src/renderer/store/appStore');
const selectors = await import('../../src/renderer/store/selectors');
const { summarizePool } = await import('../../src/core/poolSummary');

function makeThread(overrides: Partial<Thread> = {}): Thread {
  const now = Date.now();
  return {
    id: 't1',
    projectId: 'p1',
    title: 'Thread 1',
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
    id: 'acc-1',
    alias: 'Work',
    color: '#007AFF',
    email: null,
    plan: null,
    configDir: '/tmp/accounts/acc-1',
    priority: 0,
    enabled: true,
    createdAt: Date.now(),
    ...overrides,
  };
}

const EMPTY_POOL: PoolSnapshot = {
  summary: { avg: { fiveHour: null, sevenDay: null, fable: null }, earliestReset: { fiveHour: null, sevenDay: null, fable: null }, available: 0, total: 0 },
  usageById: {},
  at: 0,
};

const initialState = useAppStore.getState();

beforeEach(() => {
  useAppStore.setState(initialState, true);
  invoke.mockReset();
  on.mockReset();
});

describe('bootstrap', () => {
  it('applyBootstrap seeds projects/threads/accounts/pool/settings and selects the first thread', () => {
    const project: Project = { id: 'p1', name: 'proj', path: '/tmp/proj', trusted: false, createdAt: Date.now() };
    const thread = makeThread();
    const account = makeAccount();

    useAppStore.getState().applyBootstrap({
      projects: [project],
      threads: [thread],
      accounts: [account],
      pool: EMPTY_POOL,
      settings: { idleCloseMinutes: 10, defaultModel: 'default', defaultPermissionMode: 'default', tosNoticeAcknowledged: false },
      appVersion: '1.2.3',
      pendingPermissions: [],
    });

    const s = useAppStore.getState();
    expect(s.bootstrapped).toBe(true);
    expect(s.projects).toEqual([project]);
    expect(s.threads).toEqual([thread]);
    expect(s.accounts).toEqual([account]);
    expect(s.appVersion).toBe('1.2.3');
    expect(s.selectedThreadId).toBe('t1');
  });

  it('bootstrap() calls invoke("app:bootstrap") and applies the result', async () => {
    const payload = {
      projects: [],
      threads: [],
      accounts: [],
      pool: EMPTY_POOL,
      settings: { idleCloseMinutes: 10, defaultModel: 'default', defaultPermissionMode: 'default' as const, tosNoticeAcknowledged: false },
      appVersion: '0.1.0',
      pendingPermissions: [],
    };
    invoke.mockResolvedValueOnce(payload);

    await useAppStore.getState().bootstrap();

    expect(invoke).toHaveBeenCalledWith('app:bootstrap');
    expect(useAppStore.getState().bootstrapped).toBe(true);
    expect(useAppStore.getState().appVersion).toBe('0.1.0');
  });

  it('does not clobber an already-selected thread on re-bootstrap', () => {
    const t1 = makeThread({ id: 't1' });
    const t2 = makeThread({ id: 't2' });
    useAppStore.setState({ selectedThreadId: 't2' });
    useAppStore.getState().applyBootstrap({
      projects: [],
      threads: [t1, t2],
      accounts: [],
      pool: EMPTY_POOL,
      settings: { idleCloseMinutes: 10, defaultModel: 'default', defaultPermissionMode: 'default', tosNoticeAcknowledged: false },
      appVersion: null as unknown as string,
      pendingPermissions: [],
    });
    expect(useAppStore.getState().selectedThreadId).toBe('t2');
  });
});

describe('thread actions', () => {
  it('createThread invokes thread:create, upserts the thread, and selects it', async () => {
    const thread = makeThread({ id: 'new-thread' });
    invoke.mockResolvedValueOnce(thread);

    const result = await useAppStore.getState().createThread('p1', { title: 'X' });

    expect(invoke).toHaveBeenCalledWith('thread:create', { projectId: 'p1', title: 'X' });
    expect(result).toEqual(thread);
    expect(useAppStore.getState().threads).toContainEqual(thread);
    expect(useAppStore.getState().selectedThreadId).toBe('new-thread');
    expect(useAppStore.getState().route).toBe('chat');
  });

  it('renameThread invokes thread:rename and patches the thread locally', async () => {
    useAppStore.setState({ threads: [makeThread({ id: 't1', title: 'Old' })] });
    invoke.mockResolvedValueOnce(undefined);

    await useAppStore.getState().renameThread('t1', 'New title');

    expect(invoke).toHaveBeenCalledWith('thread:rename', { threadId: 't1', title: 'New title' });
    expect(selectors.selectThreadById(useAppStore.getState(), 't1')?.title).toBe('New title');
  });

  it('pinAccount invokes thread:pinAccount and patches pinnedAccountId locally', async () => {
    useAppStore.setState({ threads: [makeThread({ id: 't1' })] });
    invoke.mockResolvedValueOnce(undefined);

    await useAppStore.getState().pinAccount('t1', 'acc-9');

    expect(invoke).toHaveBeenCalledWith('thread:pinAccount', { threadId: 't1', accountId: 'acc-9' });
    expect(selectors.selectThreadById(useAppStore.getState(), 't1')?.pinnedAccountId).toBe('acc-9');
  });

  it('deleteThread removes the thread and its chat state, clearing selection if it was selected', async () => {
    const thread = makeThread({ id: 't1' });
    useAppStore.setState({
      threads: [thread],
      selectedThreadId: 't1',
      chatItemsByThread: { t1: [{ id: 'i1', type: 'user', text: 'hi', createdAt: 0 }] },
      streamingItemIdByThread: { t1: 'i1' },
    });
    invoke.mockResolvedValueOnce({ ok: true });

    await useAppStore.getState().deleteThread('t1');

    expect(invoke).toHaveBeenCalledWith('thread:delete', { threadId: 't1', removeWorktree: true });
    const s = useAppStore.getState();
    expect(s.threads).toEqual([]);
    expect(s.chatItemsByThread.t1).toBeUndefined();
    expect(s.streamingItemIdByThread.t1).toBeUndefined();
    expect(s.selectedThreadId).toBeNull();
  });

  it('applyThreadUpdated upserts (insert then replace) by id', () => {
    const t1 = makeThread({ id: 't1', title: 'A' });
    useAppStore.getState().applyThreadUpdated(t1);
    expect(useAppStore.getState().threads).toEqual([t1]);

    const t1b = { ...t1, title: 'B' };
    useAppStore.getState().applyThreadUpdated(t1b);
    expect(useAppStore.getState().threads).toEqual([t1b]);
  });
});

describe('chat event application', () => {
  it('text-delta sets the streaming item id for the thread', () => {
    useAppStore.getState().applyChatEvent('t1', { type: 'text-delta', itemId: 'item-1', text: 'hi' });
    expect(selectors.selectStreamingItemId(useAppStore.getState(), 't1')).toBe('item-1');
  });

  it('item-upsert appends a new item and clears streaming id when it matches', () => {
    useAppStore.getState().applyChatEvent('t1', { type: 'text-delta', itemId: 'item-1', text: 'hi' });
    const item: ChatItem = { id: 'item-1', type: 'assistant-text', text: 'hello there', createdAt: Date.now() };
    useAppStore.getState().applyChatEvent('t1', { type: 'item-upsert', item });

    const s = useAppStore.getState();
    expect(selectors.selectChatItems(s, 't1')).toEqual([item]);
    expect(selectors.selectStreamingItemId(s, 't1')).toBeNull();
  });

  it('item-upsert replaces an existing item with the same id instead of duplicating', () => {
    const item: ChatItem = { id: 'tool-1', type: 'tool', toolUseId: 'tu1', name: 'Read', input: {}, createdAt: 0 };
    useAppStore.getState().applyChatEvent('t1', { type: 'item-upsert', item });
    const updated: ChatItem = { ...item, result: 'done' };
    useAppStore.getState().applyChatEvent('t1', { type: 'item-upsert', item: updated });

    expect(selectors.selectChatItems(useAppStore.getState(), 't1')).toEqual([updated]);
  });

  it('turn-end clears the streaming item id', () => {
    useAppStore.getState().applyChatEvent('t1', { type: 'text-delta', itemId: 'item-1', text: 'x' });
    useAppStore.getState().applyChatEvent('t1', { type: 'turn-end', ok: true });
    expect(selectors.selectStreamingItemId(useAppStore.getState(), 't1')).toBeNull();
  });
});

describe('permissions', () => {
  const req: PermissionRequest = {
    requestId: 'r1',
    threadId: 't1',
    toolUseId: 'tu1',
    toolName: 'Bash',
    input: {},
    hasSessionSuggestion: true,
  };

  it('applyPermissionRequest adds, applyPermissionCancel removes', () => {
    useAppStore.getState().applyPermissionRequest(req);
    expect(selectors.selectPendingPermissions(useAppStore.getState())).toEqual([req]);
    useAppStore.getState().applyPermissionCancel('r1');
    expect(selectors.selectPendingPermissions(useAppStore.getState())).toEqual([]);
  });

  it('respondPermission invokes permission:respond and removes the request locally', async () => {
    useAppStore.setState({ permissionRequests: [req] });
    invoke.mockResolvedValueOnce(undefined);

    await useAppStore.getState().respondPermission('r1', 'allow-session', 'ok');

    expect(invoke).toHaveBeenCalledWith('permission:respond', { requestId: 'r1', decision: 'allow-session', message: 'ok' });
    expect(useAppStore.getState().permissionRequests).toEqual([]);
  });
});

describe('accounts', () => {
  it('applyAccountsUpdated replaces the full account list', () => {
    const accounts = [makeAccount({ id: 'a1' }), makeAccount({ id: 'a2' })];
    useAppStore.getState().applyAccountsUpdated(accounts);
    expect(selectors.selectAccounts(useAppStore.getState())).toEqual(accounts);
  });

  it('updateAccount invokes account:update and upserts the returned account', async () => {
    const updated = makeAccount({ id: 'a1', alias: 'Renamed' });
    invoke.mockResolvedValueOnce(updated);

    const result = await useAppStore.getState().updateAccount('a1', { alias: 'Renamed' });

    expect(invoke).toHaveBeenCalledWith('account:update', { accountId: 'a1', patch: { alias: 'Renamed' } });
    expect(result).toEqual(updated);
    expect(selectors.selectAccounts(useAppStore.getState())).toContainEqual(updated);
  });

  it('reorderAccounts reorders locally in the given order, unlisted accounts kept at the end', async () => {
    useAppStore.setState({ accounts: [makeAccount({ id: 'a1', priority: 0 }), makeAccount({ id: 'a2', priority: 1 }), makeAccount({ id: 'a3', priority: 2 })] });
    invoke.mockResolvedValueOnce(undefined);

    await useAppStore.getState().reorderAccounts(['a3', 'a1']);

    expect(invoke).toHaveBeenCalledWith('account:reorder', { orderedIds: ['a3', 'a1'] });
    expect(useAppStore.getState().accounts.map((a) => a.id)).toEqual(['a3', 'a1', 'a2']);
  });
});

describe('login sessions', () => {
  it('startLogin invokes account:loginStart and seeds an empty session', async () => {
    invoke.mockResolvedValueOnce({ loginId: 'l1', accountId: 'a1' });
    await useAppStore.getState().startLogin('Work', '#007AFF');
    expect(invoke).toHaveBeenCalledWith('account:loginStart', { alias: 'Work', color: '#007AFF' });
    expect(selectors.selectLoginSession(useAppStore.getState(), 'l1')).toEqual({ output: '', done: false, ok: null, account: null, error: null });
  });

  it('applyLoginData appends output, applyLoginExit marks done and upserts the account', () => {
    useAppStore.getState().applyLoginData('l1', 'Visit https://...\n');
    useAppStore.getState().applyLoginData('l1', 'code: 1234\n');
    expect(selectors.selectLoginSession(useAppStore.getState(), 'l1')?.output).toBe('Visit https://...\ncode: 1234\n');

    const account = makeAccount({ id: 'a1' });
    useAppStore.getState().applyLoginExit('l1', true, account);
    const session = selectors.selectLoginSession(useAppStore.getState(), 'l1');
    expect(session?.done).toBe(true);
    expect(session?.ok).toBe(true);
    expect(session?.account).toEqual(account);
    expect(selectors.selectAccounts(useAppStore.getState())).toContainEqual(account);
  });
});

describe('pty status', () => {
  it('openTerminal invokes pty:open and marks the thread running', async () => {
    invoke.mockResolvedValueOnce({ ptyId: 'pty-1', replay: 'previous output' });
    const result = await useAppStore.getState().openTerminal('t1', 80, 24);
    expect(invoke).toHaveBeenCalledWith('pty:open', { threadId: 't1', cols: 80, rows: 24 });
    expect(result).toEqual({ ptyId: 'pty-1', replay: 'previous output' });
    expect(selectors.selectPtyStatus(useAppStore.getState(), 't1')).toEqual({ ptyId: 'pty-1', running: true, lastExitCode: null });
  });

  it('applyPtyExit marks the thread not running with the exit code', () => {
    useAppStore.setState({ ptyStatusByThread: { t1: { ptyId: 'pty-1', running: true, lastExitCode: null } } });
    useAppStore.getState().applyPtyExit('t1', 0);
    expect(selectors.selectPtyStatus(useAppStore.getState(), 't1')).toEqual({ ptyId: null, running: false, lastExitCode: 0 });
  });
});

describe('ui state', () => {
  it('toggleTerminal flips terminalOpen', () => {
    expect(selectors.selectTerminalOpen(useAppStore.getState())).toBe(false);
    useAppStore.getState().toggleTerminal();
    expect(selectors.selectTerminalOpen(useAppStore.getState())).toBe(true);
  });

  it('setRoute switches between chat and accounts', () => {
    useAppStore.getState().setRoute('accounts');
    expect(selectors.selectRoute(useAppStore.getState())).toBe('accounts');
  });
});

describe('selectPoolSummary', () => {
  it('matches core/poolSummary.summarizePool over the current accounts + usageById', () => {
    const account = makeAccount({ id: 'a1', enabled: true });
    const pool: PoolSnapshot = {
      summary: EMPTY_POOL.summary,
      usageById: { a1: { fiveHour: { percent: 40, resetsAt: null }, fetchedAt: Date.now(), stale: false } },
      at: Date.now(),
    };
    useAppStore.setState({ accounts: [account], pool });

    const now = Date.now();
    const summary = selectors.selectPoolSummary(useAppStore.getState(), now);
    expect(summary).toEqual(summarizePool([account], pool.usageById, now));
  });
});

describe('review fixes', () => {
  const settings = { idleCloseMinutes: 10, defaultModel: 'default', defaultPermissionMode: 'default' as const, tosNoticeAcknowledged: false };
  const req: PermissionRequest = { requestId: 'r1', threadId: 't1', toolUseId: 'tu1', toolName: 'Edit', input: {}, hasSessionSuggestion: false };

  it('applyBootstrap restores pending permission requests (reload keeps the cards)', () => {
    useAppStore.getState().applyBootstrap({
      projects: [],
      threads: [makeThread()],
      accounts: [],
      pool: EMPTY_POOL,
      settings,
      appVersion: '1',
      pendingPermissions: [req],
    });
    expect(selectors.selectPendingPermissions(useAppStore.getState(), 't1')).toEqual([req]);
  });

  it('error ChatEvent becomes an error notice, deduped against a same-text persisted notice', () => {
    const { applyChatEvent } = useAppStore.getState();
    applyChatEvent('t1', { type: 'error', message: 'Failed to start session: boom' });
    let items = selectors.selectChatItems(useAppStore.getState(), 't1');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: 'notice', level: 'error', text: 'Failed to start session: boom' });

    // Same event again right away: not repeated.
    applyChatEvent('t1', { type: 'error', message: 'Failed to start session: boom' });
    expect(selectors.selectChatItems(useAppStore.getState(), 't1')).toHaveLength(1);

    // Main also logged it as a notice item: the persisted item replaces the local one.
    applyChatEvent('t1', {
      type: 'item-upsert',
      item: { type: 'notice', id: 'notice-1', level: 'error', text: 'Failed to start session: boom', createdAt: 1 },
    });
    items = selectors.selectChatItems(useAppStore.getState(), 't1');
    expect(items.map((i) => i.id)).toEqual(['notice-1']);
  });

  it('loadChatHistory merges by id with items that arrived live', async () => {
    const live: ChatItem[] = [
      { id: 'u1', type: 'user', text: 'hi', createdAt: 1 },
      { id: 'a1', type: 'assistant-text', text: 'hello (live)', createdAt: 2 },
      { id: 'a2', type: 'assistant-text', text: 'new', createdAt: 3 },
    ];
    useAppStore.setState({ chatItemsByThread: { t1: live } });
    invoke.mockResolvedValueOnce([
      { id: 'u0', type: 'user', text: 'earlier', createdAt: 0 },
      { id: 'u1', type: 'user', text: 'hi', createdAt: 1 },
      { id: 'a1', type: 'assistant-text', text: 'hello (log)', createdAt: 2 },
    ]);

    await useAppStore.getState().loadChatHistory('t1');

    const items = selectors.selectChatItems(useAppStore.getState(), 't1');
    expect(items.map((i) => i.id)).toEqual(['u0', 'u1', 'a1', 'a2']);
    expect(items[2]).toMatchObject({ text: 'hello (live)' });
  });

  it('setThreadPermissionMode does not patch locally; thread:updated applies the mode', async () => {
    useAppStore.setState({ threads: [makeThread()] });
    invoke.mockResolvedValueOnce(undefined);

    await useAppStore.getState().setThreadPermissionMode('t1', 'bypassPermissions');

    expect(invoke).toHaveBeenCalledWith('thread:setPermissionMode', { threadId: 't1', mode: 'bypassPermissions' });
    expect(useAppStore.getState().threads[0].permissionMode).toBe('default');
    useAppStore.getState().applyThreadUpdated(makeThread({ permissionMode: 'bypassPermissions' }));
    expect(useAppStore.getState().threads[0].permissionMode).toBe('bypassPermissions');
  });

  it('deleteThread keeps the thread when main reports a dirty worktree, force re-sends', async () => {
    useAppStore.setState({ threads: [makeThread()], selectedThreadId: 't1' });
    invoke.mockResolvedValueOnce({ ok: false, reason: 'worktree-dirty' });

    const first = await useAppStore.getState().deleteThread('t1');

    expect(first).toEqual({ ok: false, reason: 'worktree-dirty' });
    expect(useAppStore.getState().threads).toHaveLength(1);

    invoke.mockResolvedValueOnce({ ok: true });
    await useAppStore.getState().deleteThread('t1', true);
    expect(invoke).toHaveBeenLastCalledWith('thread:delete', { threadId: 't1', removeWorktree: true, force: true });
    expect(useAppStore.getState().threads).toEqual([]);
  });

  it('removeAccount throws main\'s error and keeps the account', async () => {
    useAppStore.setState({ accounts: [makeAccount({ id: 'a1' })] });
    invoke.mockResolvedValueOnce({ ok: false, error: 'No other enabled account can take over its threads.' });

    await expect(useAppStore.getState().removeAccount('a1')).rejects.toThrow('No other enabled account');
    expect(useAppStore.getState().accounts).toHaveLength(1);

    invoke.mockResolvedValueOnce({ ok: true });
    await useAppStore.getState().removeAccount('a1');
    expect(useAppStore.getState().accounts).toEqual([]);
  });

  it('setProjectTrusted applies the project main returns (dialog may decline)', async () => {
    const project: Project = { id: 'p1', name: 'proj', path: '/tmp/proj', trusted: false, createdAt: 0 };
    useAppStore.setState({ projects: [project] });
    invoke.mockResolvedValueOnce({ ...project, trusted: true });

    await useAppStore.getState().setProjectTrusted('p1', true);

    expect(invoke).toHaveBeenCalledWith('project:setTrusted', { projectId: 'p1', trusted: true });
    expect(useAppStore.getState().projects[0].trusted).toBe(true);
  });

  it('reorderAccounts rewrites priorities to match the new order', async () => {
    useAppStore.setState({ accounts: [makeAccount({ id: 'a1', priority: 0 }), makeAccount({ id: 'a2', priority: 1 })] });
    invoke.mockResolvedValueOnce(undefined);

    await useAppStore.getState().reorderAccounts(['a2', 'a1']);

    expect(useAppStore.getState().accounts.map((a) => [a.id, a.priority])).toEqual([
      ['a2', 0],
      ['a1', 1],
    ]);
  });
});
