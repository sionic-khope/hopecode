// Lane F wiring in registerIpc: chats without a project (scratch folder, no git), ACP availability / per-agent
// defaults at thread:start, ACP mode / config channels, local-auth / agent-usage channels and the account:remove
// handoff. Scratch folders live under a temp HOPECODE_HOME (never the real ~/.hopecode).
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerIpc, type IpcMainLike, type RegisterIpcServices } from '../../src/main/ipc/registerIpc';
import { InvalidIpcRequestError } from '../../src/main/ipc/guards';
import { createMemoryStore, createRecordingBroadcaster, makeAccount, makeThread } from '../../src/main/fixtures/memoryDeps';
import { scratchDir } from '../../src/main/paths';
import type { GitService, LocalAuthService, PtyManager, SessionManager } from '../../src/main/contracts';
import { DEFAULT_SETTINGS } from '../../src/shared/constants';
import type {
  Account,
  AcpControls,
  AgentKind,
  ChatSendResult,
  LocalAuthInfo,
  Project,
  Thread,
  ThreadStartResult,
} from '../../src/shared/types';

let home: string;
let previous: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'hopecode-ipc-scratch-'));
  previous = process.env['HOPECODE_HOME'];
  process.env['HOPECODE_HOME'] = home;
});
afterEach(() => {
  if (previous === undefined) delete process.env['HOPECODE_HOME'];
  else process.env['HOPECODE_HOME'] = previous;
  rmSync(home, { recursive: true, force: true });
});

function createFakeIpcMain(): IpcMainLike & { invoke: (channel: string, req?: unknown) => Promise<unknown> } {
  const handlers = new Map<string, (event: unknown, req: unknown) => unknown>();
  return {
    handle(channel, listener) {
      handlers.set(channel, listener as never);
    },
    removeHandler(channel) {
      handlers.delete(channel);
    },
    async invoke(channel, req) {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`no handler registered for ${channel}`);
      return handler({ senderFrame: { url: 'app://trusted' } }, req);
    },
  };
}

const PROJECT: Project = { id: 'p1', name: 'proj', path: '/projects/p1', trusted: true, createdAt: 0 };

interface SetupOptions {
  threads?: Thread[];
  accounts?: Account[];
  send?: ChatSendResult;
  usable?: Partial<Record<AgentKind, boolean>>;
  bypassOk?: boolean;
  checkCodexPath?: (path: string) => Promise<string | null>;
}

function setup(opts: SetupOptions = {}) {
  const store = createMemoryStore({ projects: [PROJECT], threads: opts.threads ?? [], accounts: opts.accounts ?? [] });
  const broadcaster = createRecordingBroadcaster();
  const calls: string[] = [];
  const sessionManager = {
    async send(threadId: string) {
      calls.push(`send:${threadId}`);
      return opts.send ?? { accepted: true };
    },
    async closeThread(threadId: string) {
      calls.push(`closeThread:${threadId}`);
    },
    async closeAccount(accountId: string) {
      calls.push(`closeAccount:${accountId}`);
    },
    async setEffort(threadId: string, effort: string | null) {
      calls.push(`setEffort:${threadId}:${String(effort)}`);
    },
    async setAgentMode(threadId: string, modeId: string) {
      calls.push(`setAgentMode:${threadId}:${modeId}`);
    },
    async setAgentConfig(threadId: string, configId: string, value: string | boolean) {
      calls.push(`setAgentConfig:${threadId}:${configId}:${String(value)}`);
    },
    pendingPermissions: () => [],
  } as unknown as SessionManager;
  const git = new Proxy({} as GitService, {
    get: (_t, method) => async () => {
      calls.push(`git:${String(method)}`);
      return { ok: true };
    },
  });
  const ptyOpens: { threadId: string; cwd: string; opts?: { gitCeiling?: string } }[] = [];
  const ptyManager = {
    open(threadId: string, cwd: string, _cols: number, _rows: number, o?: { gitCeiling?: string }) {
      ptyOpens.push({ threadId, cwd, ...(o ? { opts: o } : {}) });
      return { ptyId: threadId, replay: '' };
    },
    kill(threadId: string) {
      calls.push(`ptyKill:${threadId}`);
    },
  } as unknown as PtyManager;
  const accounts = opts.accounts ?? [];
  const accountOps: string[] = [];
  const authInfo = (agent: AgentKind, state: LocalAuthInfo['state']): LocalAuthInfo => ({
    agent,
    state,
    method: null,
    email: agent === 'claude-code' ? 'local@example.com' : null,
    plan: null,
    provider: null,
    source: 'test',
    version: null,
    detail: null,
    checkedAt: 0,
  });
  const rechecks: { agent?: AgentKind; force?: boolean }[] = [];
  const authListeners = new Set<(list: LocalAuthInfo[]) => void>();
  const localAuth: LocalAuthService = {
    list: () => [authInfo('codex', 'logged-in')],
    async recheck(agent, o) {
      rechecks.push({ ...(agent ? { agent } : {}), ...(o?.force ? { force: true } : {}) });
      return [authInfo('claude-code', 'logged-in')];
    },
    availability: (agent) =>
      opts.usable?.[agent] === false ? { agent, usable: false, reason: 'not-logged-in' } : { agent, usable: true, reason: 'ok' },
    onChange(cb) {
      authListeners.add(cb);
      return () => authListeners.delete(cb);
    },
  };
  const activeAgents: (AgentKind | null)[] = [];
  const services = {
    store,
    threadLog: { remove: async () => {}, read: async () => [] },
    sessionManager,
    accountPool: {
      list: () => accounts,
      get: (id: string) => accounts.find((a) => a.id === id),
      update(id: string, patch: Partial<Account>) {
        accountOps.push(`update:${id}:${JSON.stringify(patch)}`);
        const a = accounts.find((x) => x.id === id)!;
        Object.assign(a, patch);
        return a;
      },
      async remove(id: string, del: boolean) {
        accountOps.push(`remove:${id}:${del}`);
        accounts.splice(
          accounts.findIndex((a) => a.id === id),
          1,
        );
      },
      addLocalDefault(input: { email: string | null; plan: string | null }) {
        accountOps.push(`addLocalDefault:${input.email}`);
        const a = makeAccount('local', { ...input, source: 'local-default' });
        accounts.push(a);
        return a;
      },
      onChange: () => () => {},
    },
    localAuth,
    agentUsage: {
      get: () => null,
      refresh: async () => null,
      onUpdate: () => () => {},
      setActive: (agent: AgentKind | null) => void activeAgents.push(agent),
    },
    usagePoller: { onUpdate: () => () => {}, getSnapshot: () => ({}) },
    ptyManager,
    worktreeManager: {
      create: async (_path: string, shortId: string) => ({
        cwd: `/wt/${shortId}`,
        worktree: { path: `/wt/${shortId}`, branch: `hopecode/${shortId}` },
      }),
      isDirty: async () => false,
      remove: async (_p: string, w: { path: string }) => void calls.push(`worktreeRemove:${w.path}`),
    },
    dialogs: {
      confirmBypassPermissions: async () => {
        calls.push('confirmBypass');
        return opts.bypassOk ?? false;
      },
    },
    broadcaster,
    appVersion: '0.0.0-test',
    isTrustedSender: () => true,
    syncTranscript: async (sid: string, from: string, to: string) => {
      accountOps.push(`sync:${sid}:${from}->${to}`);
      return { found: true, copied: [] };
    },
    gitService: git,
    editorLauncher: { open: async (editor: string, dir: string) => void calls.push(`editor:${editor}:${dir}`) },
    ...(opts.checkCodexPath ? { checkCodexPath: opts.checkCodexPath } : {}),
    testMode: true,
  } as unknown as RegisterIpcServices;
  const ipcMain = createFakeIpcMain();
  registerIpc(ipcMain, services);
  return { ipcMain, store, calls, ptyOpens, broadcaster, accountOps, rechecks, authListeners, activeAgents, accounts };
}

const start = (ipcMain: ReturnType<typeof setup>['ipcMain'], req: Record<string, unknown>) =>
  ipcMain.invoke('thread:start', req) as Promise<ThreadStartResult>;

describe('thread:start without a project (scratch chat)', () => {
  it('creates <scratch>/<threadId> as the cwd, with projectId null and no worktree', async () => {
    const { ipcMain, calls } = setup();
    const res = await start(ipcMain, { text: 'hello' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.thread.projectId).toBeNull();
    expect(res.thread.worktree).toBeUndefined();
    expect(res.thread.cwd).toBe(join(scratchDir(), res.thread.id));
    expect(res.thread.cwd.startsWith(join(home, 'home', 'scratch'))).toBe(true);
    expect(existsSync(res.thread.cwd)).toBe(true);
    expect(calls).toEqual([`send:${res.thread.id}`]);
  });

  it('a raw folder path in the request is never used (folders only enter through project:add)', async () => {
    const { ipcMain } = setup();
    const res = await start(ipcMain, { projectPath: '/etc', text: 'x' });
    expect(res.ok && res.thread.cwd.startsWith(scratchDir())).toBe(true);
  });

  it('a refused first send rolls back: the scratch folder and the thread are gone', async () => {
    const { ipcMain, store } = setup({ send: { accepted: false, reason: 'no-accounts' } });
    const res = await start(ipcMain, { text: 'hello' });
    expect(res).toEqual({ ok: false, reason: 'no-accounts' });
    expect(store.get().threads).toEqual([]);
    expect(existsSync(scratchDir()) ? readdirSync(scratchDir()) : []).toEqual([]);
  });

  it('thread:delete removes the scratch folder', async () => {
    const { ipcMain, store } = setup();
    const res = await start(ipcMain, { text: 'hello' });
    if (!res.ok) throw new Error('start failed');
    expect(await ipcMain.invoke('thread:delete', { threadId: res.thread.id, removeWorktree: true })).toEqual({ ok: true });
    expect(existsSync(res.thread.cwd)).toBe(false);
    expect(store.getThread(res.thread.id)).toBeUndefined();
  });
});

describe('git / editor / pty for a chat without a project', () => {
  const scratchThread = () => makeThread('s1', { projectId: null, cwd: '/scratch/s1' });

  it('git channels never run git', async () => {
    const { ipcMain, calls } = setup({ threads: [scratchThread()] });
    expect(await ipcMain.invoke('git:changes', { threadId: 's1' })).toMatchObject({ isRepo: false, files: [] });
    expect(await ipcMain.invoke('git:fileDiff', { threadId: 's1', path: 'a.txt' })).toEqual({ path: 'a.txt', binary: false, hunks: [] });
    expect(await ipcMain.invoke('git:remoteInfo', { threadId: 's1' })).toMatchObject({ remote: null, ghAvailable: false });
    for (const [channel, req] of [
      ['git:revertFile', { threadId: 's1', path: 'a.txt' }],
      ['git:commit', { threadId: 's1', message: 'm' }],
      ['git:merge', { threadId: 's1' }],
      ['git:pushPr', { threadId: 's1', title: 't', body: '' }],
      ['git:createBranch', { threadId: 's1', name: 'b' }],
    ] as const) {
      expect(await ipcMain.invoke(channel, req)).toMatchObject({ ok: false, error: expect.stringMatching(/프로젝트 없는/) });
    }
    expect(calls.filter((c) => c.startsWith('git:'))).toEqual([]);
  });

  it('a project thread still runs git', async () => {
    const { ipcMain, calls } = setup({ threads: [makeThread('t1', { projectId: 'p1' })] });
    await ipcMain.invoke('git:changes', { threadId: 't1' });
    expect(calls).toContain('git:changes');
  });

  it('editor:open allows only Finder', async () => {
    const { ipcMain, calls } = setup({ threads: [scratchThread()] });
    await expect(ipcMain.invoke('editor:open', { threadId: 's1', editor: 'vscode' })).rejects.toBeInstanceOf(InvalidIpcRequestError);
    await ipcMain.invoke('editor:open', { threadId: 's1', editor: 'finder' });
    expect(calls).toEqual(['editor:finder:/scratch/s1']);
  });

  it('the thread shell gets GIT_CEILING_DIRECTORIES=<scratch root>; project threads and the draft do not', async () => {
    const { ipcMain, ptyOpens } = setup({ threads: [scratchThread(), makeThread('t1', { projectId: 'p1' })] });
    await ipcMain.invoke('pty:open', { threadId: 's1', cols: 80, rows: 24 });
    await ipcMain.invoke('pty:open', { threadId: 't1', cols: 80, rows: 24 });
    await ipcMain.invoke('pty:restart', { threadId: 's1', cols: 80, rows: 24 });
    expect(ptyOpens).toEqual([
      { threadId: 's1', cwd: '/scratch/s1', opts: { gitCeiling: scratchDir() } },
      { threadId: 't1', cwd: '/work/project' },
      { threadId: 's1', cwd: '/scratch/s1', opts: { gitCeiling: scratchDir() } },
    ]);
  });
});

describe('thread:start for ACP agents', () => {
  it('an unavailable agent is refused before any worktree or folder exists', async () => {
    const { ipcMain, store, calls } = setup({ usable: { codex: false } });
    expect(await start(ipcMain, { projectId: 'p1', text: 'x', agent: 'codex' })).toEqual({ ok: false, reason: 'agent-unavailable' });
    expect(await start(ipcMain, { text: 'x', agent: 'codex' })).toEqual({ ok: false, reason: 'agent-unavailable' });
    expect(store.get().threads).toEqual([]);
    expect(calls).toEqual([]);
    expect(existsSync(scratchDir())).toBe(false);
  });

  it('per-agent defaults: Codex from settings unless the draft chose, Hermes never sets them', async () => {
    const { ipcMain } = setup();
    const codex = await start(ipcMain, { projectId: 'p1', text: 'x', agent: 'codex' });
    expect(codex.ok && [codex.thread.model, codex.thread.effort]).toEqual([
      DEFAULT_SETTINGS.codexDefaultModel,
      DEFAULT_SETTINGS.codexDefaultEffort,
    ]);
    const chosen = await start(ipcMain, { projectId: 'p1', text: 'x', agent: 'codex', model: 'gpt-x', effort: 'low' });
    expect(chosen.ok && [chosen.thread.model, chosen.thread.effort]).toEqual(['gpt-x', 'low']);
    // Codex has its own effort set: `ultra` is valid for Codex, not for Claude.
    const ultra = await start(ipcMain, { projectId: 'p1', text: 'x', agent: 'codex', effort: 'ultra' as never });
    expect(ultra.ok && ultra.thread.effort).toBe('ultra');
    await expect(start(ipcMain, { projectId: 'p1', text: 'x', effort: 'ultra' as never })).rejects.toBeInstanceOf(InvalidIpcRequestError);
    const hermes = await start(ipcMain, { projectId: 'p1', text: 'x', agent: 'hermes', model: 'ignored', effort: 'max' });
    expect(hermes.ok && [hermes.thread.model, hermes.thread.effort, hermes.thread.agent]).toEqual(['', null, 'hermes']);
    const claude = await start(ipcMain, { projectId: 'p1', text: 'x' });
    expect(claude.ok && [claude.thread.model, claude.thread.effort]).toEqual([DEFAULT_SETTINGS.defaultModel, DEFAULT_SETTINGS.defaultEffort]);
  });

  it('a Codex model that could inject into `-c model="..."` is refused', async () => {
    const { ipcMain } = setup();
    await expect(start(ipcMain, { projectId: 'p1', text: 'x', agent: 'codex', model: 'a" -c x="y' })).rejects.toBeInstanceOf(
      InvalidIpcRequestError,
    );
  });
});

describe('ACP mode / config channels', () => {
  const controls: AcpControls = {
    modes: [
      { id: 'default', name: 'Default' },
      { id: 'yolo', name: 'Full access' },
    ],
    currentModeId: 'default',
    configOptions: [
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'gpt-a',
        options: [
          { value: 'gpt-a', name: 'A' },
          { value: 'gpt-b', name: 'B' },
        ],
      },
      {
        id: 'reasoning_effort',
        name: 'Reasoning Effort',
        category: 'thought_level',
        type: 'select',
        currentValue: 'high',
        options: [
          { value: 'high', name: 'high' },
          { value: 'ultra', name: 'ultra' },
        ],
      },
      { id: 'fast', name: 'Fast', category: null, type: 'boolean', currentValue: false },
      {
        id: 'approval_preset',
        name: 'Approval Preset',
        category: 'mode',
        type: 'select',
        currentValue: 'auto',
        options: [
          { value: 'auto', name: 'auto' },
          { value: 'full-access', name: 'full-access' },
        ],
      },
    ],
    reportedModel: null,
  };
  const acpThread = (agent: AgentKind) => makeThread('h1', { agent, acp: { sessionId: 's', controls } });

  it('setAgentMode: only a reported mode; a full-access mode needs the native confirm', async () => {
    const declined = setup({ threads: [acpThread('hermes')], bypassOk: false });
    await declined.ipcMain.invoke('thread:setAgentMode', { threadId: 'h1', modeId: 'default' });
    await declined.ipcMain.invoke('thread:setAgentMode', { threadId: 'h1', modeId: 'yolo' });
    await expect(declined.ipcMain.invoke('thread:setAgentMode', { threadId: 'h1', modeId: 'nope' })).rejects.toBeInstanceOf(
      InvalidIpcRequestError,
    );
    expect(declined.calls).toEqual(['setAgentMode:h1:default', 'confirmBypass']);

    const approved = setup({ threads: [acpThread('hermes')], bypassOk: true });
    await approved.ipcMain.invoke('thread:setAgentMode', { threadId: 'h1', modeId: 'yolo' });
    expect(approved.calls).toEqual(['confirmBypass', 'setAgentMode:h1:yolo']);

    // Without a live session the stored "current" mode may be stale: a full-access mode always asks.
    const stale = setup({ threads: [makeThread('h1', { agent: 'hermes', acp: { sessionId: null, controls: { ...controls, currentModeId: 'yolo' } } })], bypassOk: false });
    await stale.ipcMain.invoke('thread:setAgentMode', { threadId: 'h1', modeId: 'yolo' });
    expect(stale.calls).toEqual(['confirmBypass']);
  });

  it('thread:setEffort: `ultra` only for Codex threads', async () => {
    const { ipcMain, calls } = setup({ threads: [acpThread('codex'), makeThread('c1')] });
    await ipcMain.invoke('thread:setEffort', { threadId: 'h1', effort: 'ultra' });
    await expect(ipcMain.invoke('thread:setEffort', { threadId: 'c1', effort: 'ultra' })).rejects.toBeInstanceOf(InvalidIpcRequestError);
    await ipcMain.invoke('thread:setEffort', { threadId: 'c1', effort: 'max' });
    expect(calls).toEqual(['setEffort:h1:ultra', 'setEffort:c1:max']);
  });

  it('setAgentMode is Hermes-only: Codex modes go through the permission chip', async () => {
    const { ipcMain, calls } = setup({ threads: [acpThread('codex')], bypassOk: true });
    await expect(ipcMain.invoke('thread:setAgentMode', { threadId: 'h1', modeId: 'yolo' })).rejects.toBeInstanceOf(InvalidIpcRequestError);
    await expect(ipcMain.invoke('thread:setAgentMode', { threadId: 'h1', modeId: 'default' })).rejects.toBeInstanceOf(InvalidIpcRequestError);
    expect(calls).toEqual([]);
  });

  it('setAgentConfig: option and value must be reported; Claude threads are refused', async () => {
    const { ipcMain, calls, broadcaster } = setup({ threads: [acpThread('codex'), makeThread('c1')] });
    await ipcMain.invoke('thread:setAgentConfig', { threadId: 'h1', configId: 'model', value: 'gpt-b' });
    await ipcMain.invoke('thread:setAgentConfig', { threadId: 'h1', configId: 'reasoning_effort', value: 'ultra' });
    for (const req of [
      { threadId: 'h1', configId: 'model', value: 'gpt-z' },
      // Only model / thought_level are settable (M-1): a `mode` preset could grant full access without the confirm.
      { threadId: 'h1', configId: 'approval_preset', value: 'full-access' },
      { threadId: 'h1', configId: 'approval_preset', value: 'auto' },
      { threadId: 'h1', configId: 'fast', value: true },
      { threadId: 'h1', configId: 'ghost', value: 'x' },
      { threadId: 'c1', configId: 'model', value: 'gpt-b' },
    ]) {
      await expect(ipcMain.invoke('thread:setAgentConfig', req)).rejects.toBeInstanceOf(InvalidIpcRequestError);
    }
    expect(calls).toEqual(['setAgentConfig:h1:model:gpt-b', 'setAgentConfig:h1:reasoning_effort:ultra']);
    expect(broadcaster.of('thread:updated')).toHaveLength(2);
  });
});

describe('local auth / agent usage channels', () => {
  it('agents:list reads the cache, agents:recheck forces, changes are broadcast as agents:updated', async () => {
    const { ipcMain, rechecks, authListeners, broadcaster } = setup();
    expect(await ipcMain.invoke('agents:list')).toMatchObject([{ agent: 'codex', state: 'logged-in' }]);
    await ipcMain.invoke('agents:recheck', { agent: 'hermes' });
    await ipcMain.invoke('agents:recheck', {});
    expect(rechecks).toEqual([{ agent: 'hermes', force: true }, { force: true }]);
    await expect(ipcMain.invoke('agents:recheck', { agent: 'gpt' })).rejects.toBeInstanceOf(InvalidIpcRequestError);
    for (const cb of authListeners) cb([]);
    expect(broadcaster.of('agents:updated')).toEqual([[]]);
  });

  it('bootstrap carries localAuth and the Hermes usage slot', async () => {
    const { ipcMain } = setup();
    expect(await ipcMain.invoke('app:bootstrap')).toMatchObject({ localAuth: [{ agent: 'codex' }], agentUsage: { hermes: null } });
  });

  it('agentUsage:setActive takes an agent kind or null', async () => {
    const { ipcMain, activeAgents } = setup();
    await ipcMain.invoke('agentUsage:setActive', { agent: 'hermes' });
    await ipcMain.invoke('agentUsage:setActive', { agent: null });
    await expect(ipcMain.invoke('agentUsage:setActive', { agent: 'x' })).rejects.toBeInstanceOf(InvalidIpcRequestError);
    expect(activeAgents).toEqual(['hermes', null]);
  });
});

describe('account:remove / account:setLocalDefault wiring (removeAccountWithHandoff)', () => {
  it('a managed account: close Queries, hand transcripts over, then remove with the requested deleteConfigDir', async () => {
    const accounts = [makeAccount('a1', { configDir: '/acc/a1' }), makeAccount('b1', { configDir: '/acc/b1' })];
    const { ipcMain, accountOps, calls, store } = setup({
      accounts,
      threads: [makeThread('t1', { lastAccountId: 'a1', sdkSessionId: 'sid' })],
    });
    expect(await ipcMain.invoke('account:remove', { accountId: 'a1', deleteConfigDir: true })).toEqual({ ok: true });
    expect(calls).toEqual(['closeAccount:a1']);
    expect(accountOps).toEqual(['update:a1:{"enabled":false}', 'sync:sid:/acc/a1->/acc/b1', 'remove:a1:true']);
    expect(store.getThread('t1')?.lastAccountId).toBe('b1');
  });

  it('the local account is removed with deleteConfigDir=false and stays out of the pool (localClaudeInPool=false)', async () => {
    const accounts = [makeAccount('local', { source: 'local-default', configDir: '/home/.claude' })];
    const { ipcMain, accountOps, store } = setup({ accounts });
    expect(await ipcMain.invoke('account:remove', { accountId: 'local', deleteConfigDir: true })).toEqual({ ok: true });
    expect(accountOps).toContain('remove:local:false');
    expect(accountOps).not.toContain('remove:local:true');
    expect(store.get().settings.localClaudeInPool).toBe(false);
  });

  it('account:setLocalDefault include=true re-detects Claude (forced) and enrolls the local login', async () => {
    const { ipcMain, accountOps, rechecks, store } = setup();
    store.update((d) => {
      d.settings.localClaudeInPool = false;
    });
    expect(await ipcMain.invoke('account:setLocalDefault', { include: true })).toEqual({ ok: true });
    expect(store.get().settings.localClaudeInPool).toBe(true);
    expect(rechecks).toEqual([{ agent: 'claude-code', force: true }]);
    expect(accountOps).toEqual(['addLocalDefault:local@example.com']);
  });
});

describe('settings:update codexPath (Settings > Codex 실행 파일 경로)', () => {
  it('stores a path only after main checked it; a refused path changes nothing; empty resets without a check', async () => {
    const checked: string[] = [];
    const { ipcMain, store } = setup({
      checkCodexPath: async (path) => {
        checked.push(path);
        return path === '/ok/codex' ? null : 'codex-cli 0.100.0은(는) 지원하지 않습니다';
      },
    });
    await ipcMain.invoke('settings:update', { codexPath: '/ok/codex' });
    expect(store.get().settings.codexPath).toBe('/ok/codex');
    await expect(ipcMain.invoke('settings:update', { codexPath: '/old/codex' })).rejects.toThrow(/지원하지 않습니다/);
    expect(store.get().settings.codexPath).toBe('/ok/codex');
    await expect(ipcMain.invoke('settings:update', { codexPath: 'relative/codex' })).rejects.toThrow();
    await ipcMain.invoke('settings:update', { codexPath: '' });
    expect(store.get().settings.codexPath).toBe('');
    expect(checked).toEqual(['/ok/codex', '/old/codex']);
  });

  it('without a checker a non-empty path is refused', async () => {
    const { ipcMain, store } = setup();
    await expect(ipcMain.invoke('settings:update', { codexPath: '/any/codex' })).rejects.toThrow();
    expect(store.get().settings.codexPath).toBe('');
  });
});
