// Local Claude login as a pool account (plan 2.9.5, AC7). All paths are temp dirs; the real ~/.claude is never used.
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAccountPool } from '../../src/main/accounts/accountPool';
import { createCredentials, type ExecFileFn } from '../../src/main/accounts/credentials';
import {
  assertNotLocalClaudeDir,
  claudeConfigDirFor,
  ENV_FIXTURE_LOCAL_CLAUDE,
  isLocalDefault,
  localClaudeEnrollAllowed,
  removeAccountWithHandoff,
  setLocalDefaultInPool,
  syncLocalDefaultAccount,
} from '../../src/main/accounts/localDefault';
import { createMemoryStore, createRecordingBroadcaster, makeAccount, makeThread } from '../../src/main/fixtures/memoryDeps';
import { createUsagePoller } from '../../src/main/usage/usagePoller';
import type { Account, LocalAuthInfo } from '../../src/shared/types';

let root: string;
let localDir: string;
let accountsDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hopecode-local-'));
  localDir = join(root, 'home', 'fake-claude');
  accountsDir = join(root, 'home', 'accounts');
  mkdirSync(join(localDir, 'projects'), { recursive: true });
  writeFileSync(join(localDir, '.credentials.json'), '{}');
  mkdirSync(accountsDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const claudeInfo = (over: Partial<LocalAuthInfo> = {}): LocalAuthInfo => ({
  agent: 'claude-code',
  state: 'logged-in',
  method: 'claude.ai',
  email: 'me@example.com',
  plan: 'max',
  provider: null,
  source: 'Keychain: Claude Code-credentials',
  version: '2.1.282',
  detail: null,
  checkedAt: 1,
  ...over,
});

function setup(accounts: Account[] = [], threads = [makeThread('t1')], settings: { localClaudeInPool?: boolean } = {}) {
  const store = createMemoryStore({ accounts, threads, settings: settings as never });
  const broadcaster = createRecordingBroadcaster();
  const credentials = { invalidate: vi.fn(), deleteKeychainItem: vi.fn(async () => {}) };
  const removeConfigDir = vi.fn(async () => {});
  const order: string[] = [];
  const pool = createAccountPool({
    store,
    accountsDir: () => accountsDir,
    links: { linkSharedConfig: async () => ({ linked: [], skipped: [] }) },
    startLogin: () => {
      throw new Error('unused');
    },
    credentials,
    broadcaster,
    removeConfigDir,
    localClaudeDir: () => localDir,
    newId: () => 'local',
    now: () => 5,
  });
  const sessionManager = {
    closeAccount: vi.fn(async (id: string) => {
      order.push(`close:${id}`);
    }),
  };
  const syncTranscript = vi.fn(async (sid: string, from: string, to: string) => {
    order.push(`sync:${sid}:${from}->${to}`);
    return { found: true, copied: [] as string[] };
  });
  const recheckClaude = vi.fn(async () => claudeInfo());
  const log = vi.fn();
  const deps = {
    accountPool: pool,
    store,
    sessionManager,
    syncTranscript,
    broadcaster,
    log,
    recheckClaude,
    fixtures: false,
  };
  const sync = (info: LocalAuthInfo | undefined, fixtures = false, env?: (n: string) => string | undefined) =>
    syncLocalDefaultAccount({ pool, settings: () => store.get().settings, fixtures, env }, info);
  return { store, broadcaster, credentials, removeConfigDir, pool, sessionManager, syncTranscript, recheckClaude, log, deps, order, sync };
}

describe('assertNotLocalClaudeDir', () => {
  it('refuses the local dir, an ancestor, a path inside it, and symlinks resolving to them', () => {
    const link = join(root, 'link-to-local');
    symlinkSync(localDir, link);
    for (const p of [localDir, join(root, 'home'), join(localDir, 'projects'), link, join(link, 'projects')]) {
      expect(() => assertNotLocalClaudeDir(p, localDir)).toThrow(/refusing/);
    }
    expect(() => assertNotLocalClaudeDir(join(accountsDir, 'a1'), localDir)).not.toThrow();
  });
});

describe('isLocalDefault / claudeConfigDirFor', () => {
  it('branches only on source', () => {
    expect(isLocalDefault(makeAccount('a'))).toBe(false);
    expect(isLocalDefault(makeAccount('a', { source: 'managed' }))).toBe(false);
    expect(isLocalDefault(makeAccount('l', { source: 'local-default' }))).toBe(true);
    expect(isLocalDefault(undefined)).toBe(false);
    expect(claudeConfigDirFor(makeAccount('a', { configDir: '/acc/a' }))).toBe('/acc/a');
    expect(claudeConfigDirFor(makeAccount('l', { source: 'local-default', configDir: localDir }))).toBeUndefined();
  });
});

describe('auto-enrollment', () => {
  it('logged-in local Claude joins the end of the pool, enabled, with detector email / plan', () => {
    const t = setup([makeAccount('a', { priority: 0 }), makeAccount('b', { priority: 1 })]);
    expect(t.sync(claudeInfo())).toBe('added');
    const local = t.pool.list().at(-1)!;
    expect(local).toMatchObject({ source: 'local-default', configDir: localDir, priority: 2, enabled: true, email: 'me@example.com', plan: 'max' });
    expect(t.sync(claudeInfo())).toBe('present');
    expect(t.pool.list()).toHaveLength(3);
  });

  it('is skipped for a same-email managed account, logged-out detector or localClaudeInPool=false', () => {
    const dup = setup([makeAccount('a', { email: 'ME@example.com' })]);
    expect(dup.sync(claudeInfo())).toBe('same-email');
    expect(dup.pool.list()).toHaveLength(1);

    const out = setup();
    expect(out.sync(claudeInfo({ state: 'logged-out' }))).toBe('not-logged-in');
    expect(out.sync(undefined)).toBe('not-logged-in');

    const off = setup([], [], { localClaudeInPool: false });
    expect(off.sync(claudeInfo())).toBe('off');
    expect(off.pool.list()).toHaveLength(0);
  });

  it('fixture mode: off by default, opt-in with HOPECODE_FIXTURE_LOCAL_CLAUDE=1 only', () => {
    const t = setup();
    expect(t.sync(claudeInfo(), true, () => undefined)).toBe('fixture-off');
    expect(t.sync(claudeInfo(), true, (n) => (n === ENV_FIXTURE_LOCAL_CLAUDE ? '0' : undefined))).toBe('fixture-off');
    expect(t.pool.list()).toHaveLength(0);
    expect(t.sync(claudeInfo(), true, (n) => (n === ENV_FIXTURE_LOCAL_CLAUDE ? '1' : undefined))).toBe('added');

    expect(localClaudeEnrollAllowed(false, () => undefined)).toBe(true);
    const previous = process.env[ENV_FIXTURE_LOCAL_CLAUDE];
    try {
      delete process.env[ENV_FIXTURE_LOCAL_CLAUDE];
      expect(localClaudeEnrollAllowed(true)).toBe(false);
      process.env[ENV_FIXTURE_LOCAL_CLAUDE] = '1';
      expect(localClaudeEnrollAllowed(true)).toBe(true);
    } finally {
      if (previous === undefined) delete process.env[ENV_FIXTURE_LOCAL_CLAUDE];
      else process.env[ENV_FIXTURE_LOCAL_CLAUDE] = previous;
    }
  });
});

describe('toggle off = account:remove flow with deleteConfigDir=false', () => {
  it('closes the account, hands transcripts to the heir, removes from the pool, saves localClaudeInPool=false', async () => {
    const heir = makeAccount('heir', { priority: 0, configDir: join(accountsDir, 'heir') });
    const sid = '11111111-2222-4333-8444-555555555555';
    const t = setup([heir], [
      makeThread('t1', { lastAccountId: 'local', activeAccountId: 'local', pinnedAccountId: 'local', sdkSessionId: sid }),
      makeThread('t2', { lastAccountId: 'heir' }),
    ]);
    t.sync(claudeInfo({ email: 'other@example.com' }));
    vi.spyOn(t.pool, 'remove').mockImplementation(async (id, del) => {
      t.order.push(`remove:${id}:${del}`);
    });

    expect(await setLocalDefaultInPool(t.deps, false)).toEqual({ ok: true });
    expect(t.order).toEqual(['close:local', `sync:${sid}:${localDir}->${heir.configDir}`, 'remove:local:false']);
    expect(t.store.getThread('t1')).toMatchObject({ lastAccountId: 'heir', activeAccountId: null, pinnedAccountId: null });
    expect(t.store.getThread('t2')!.lastAccountId).toBe('heir');
    expect(t.store.get().settings.localClaudeInPool).toBe(false);
    expect(t.broadcaster.of('settings:updated').at(-1)).toMatchObject({ localClaudeInPool: false });
  });

  it('real pool: the local account leaves without Keychain / dir deletion; ~/.claude stays intact', async () => {
    const t = setup([makeAccount('heir', { priority: 0 })]);
    t.sync(claudeInfo({ email: 'other@example.com' }));
    expect(await setLocalDefaultInPool(t.deps, false)).toEqual({ ok: true });
    expect(t.pool.list().map((a) => a.id)).toEqual(['heir']);
    expect(t.credentials.deleteKeychainItem).not.toHaveBeenCalled();
    expect(t.removeConfigDir).not.toHaveBeenCalled();
    expect(existsSync(join(localDir, '.credentials.json'))).toBe(true);
    // Not re-enrolled while the toggle is off.
    expect(t.sync(claudeInfo({ email: 'other@example.com' }))).toBe('off');
  });

  it('account:remove of the local account with deleteConfigDir=true is forced to false (logged)', async () => {
    const t = setup([makeAccount('heir', { priority: 0 })]);
    t.sync(claudeInfo({ email: 'other@example.com' }));
    const spy = vi.spyOn(t.pool, 'remove');
    expect(await removeAccountWithHandoff(t.deps, 'local', true)).toEqual({ ok: true });
    expect(spy).toHaveBeenCalledWith('local', false);
    expect(t.log).toHaveBeenCalledWith(expect.stringContaining('ignoring deleteConfigDir'));
    expect(t.credentials.deleteKeychainItem).not.toHaveBeenCalled();
    expect(t.removeConfigDir).not.toHaveBeenCalled();
  });

  it('no heir for dependent threads: refuses and keeps the setting on', async () => {
    const t = setup([], [makeThread('t1', { lastAccountId: 'local' })]);
    t.sync(claudeInfo());
    const res = await setLocalDefaultInPool(t.deps, false);
    expect(res.ok).toBe(false);
    expect(t.pool.list().map((a) => a.id)).toEqual(['local']);
    expect(t.store.get().settings.localClaudeInPool).toBe(true);
    expect(t.sessionManager.closeAccount).not.toHaveBeenCalled();
  });

  it('failed transcript handoff aborts and re-enables the local account', async () => {
    const t = setup([makeAccount('heir', { priority: 0 })], [makeThread('t1', { lastAccountId: 'local', sdkSessionId: '11111111-2222-4333-8444-555555555555' })]);
    t.sync(claudeInfo({ email: 'other@example.com' }));
    t.syncTranscript.mockRejectedValueOnce(new Error('disk full'));
    const res = await setLocalDefaultInPool(t.deps, false);
    expect(res).toMatchObject({ ok: false });
    expect(t.pool.get('local')).toMatchObject({ enabled: true });
    expect(t.store.get().settings.localClaudeInPool).toBe(true);
  });
});

describe('toggle off vs. a concurrent re-detection (M6)', () => {
  it('localClaudeInPool=false is saved before the handoff, so a re-detection meanwhile does not re-enroll', async () => {
    const t = setup([makeAccount('heir', { priority: 0 })], [makeThread('t1', { lastAccountId: 'local', sdkSessionId: '11111111-2222-4333-8444-555555555555' })]);
    t.sync(claudeInfo({ email: 'other@example.com' }));
    const during: { inPool: boolean; sync: string }[] = [];
    t.syncTranscript.mockImplementationOnce(async () => {
      during.push({ inPool: t.store.get().settings.localClaudeInPool, sync: t.sync(claudeInfo({ email: 'other@example.com' })) });
      return { found: true, copied: [] };
    });
    expect(await setLocalDefaultInPool(t.deps, false)).toEqual({ ok: true });
    expect(during).toEqual([{ inPool: false, sync: 'off' }]);
    expect(t.sync(claudeInfo({ email: 'other@example.com' }))).toBe('off');
    expect(t.pool.list().map((a) => a.id)).toEqual(['heir']);
  });

  it('a failed handoff restores localClaudeInPool=true', async () => {
    const t = setup([makeAccount('heir', { priority: 0 })], [makeThread('t1', { lastAccountId: 'local', sdkSessionId: '11111111-2222-4333-8444-555555555555' })]);
    t.sync(claudeInfo({ email: 'other@example.com' }));
    t.syncTranscript.mockRejectedValueOnce(new Error('disk full'));
    expect((await setLocalDefaultInPool(t.deps, false)).ok).toBe(false);
    expect(t.store.get().settings.localClaudeInPool).toBe(true);
    expect(t.broadcaster.of('settings:updated').map((s) => s.localClaudeInPool)).toEqual([false, true]);
  });
});

describe('toggle on', () => {
  it('saves localClaudeInPool=true, re-detects and enrolls', async () => {
    const t = setup([], [], { localClaudeInPool: false });
    expect(await setLocalDefaultInPool(t.deps, true)).toEqual({ ok: true });
    expect(t.store.get().settings.localClaudeInPool).toBe(true);
    expect(t.recheckClaude).toHaveBeenCalledTimes(1);
    expect(t.pool.list()).toEqual([expect.objectContaining({ id: 'local', source: 'local-default' })]);
  });
});

describe('usage poller with the local account', () => {
  it('reads the base Keychain service `Claude Code-credentials`', async () => {
    const execFile = vi.fn<ExecFileFn>(async () => {
      throw new Error('not found');
    });
    const credentials = createCredentials({
      execFile,
      readFile: async () => {
        throw new Error('ENOENT');
      },
      username: () => 'alice',
      platform: 'darwin',
      localClaudeDir: () => localDir,
    });
    const local = makeAccount('local', { source: 'local-default', configDir: localDir });
    const poller = createUsagePoller({
      listAccounts: () => [local],
      credentials,
      client: { fetchUsage: vi.fn() },
      cliVersion: () => null,
      history: { append: async () => true },
    });
    await poller.refresh('local');
    const services = execFile.mock.calls.map((c) => c[1][c[1].indexOf('-s') + 1]);
    expect(services.length).toBeGreaterThan(0);
    expect(new Set(services)).toEqual(new Set(['Claude Code-credentials']));
  });
});
