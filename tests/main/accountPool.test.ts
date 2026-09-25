import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAccountPool, type StartLoginFn } from '../../src/main/accounts/accountPool';
import { linkSharedConfig } from '../../src/main/accounts/configDirLinks';
import {
  parseAuthStatus,
  startLoginFlow,
  type LoginFlowDeps,
  type PtyLike,
  type RunCommandFn,
  type SpawnPtyFn,
} from '../../src/main/accounts/loginFlow';
import { DEFAULT_SETTINGS } from '../../src/shared/constants';
import type { EventChannel, EventPayload } from '../../src/shared/ipc';
import type { Account, ChildEnvInject, PersistedState } from '../../src/shared/types';

// ---------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------

class FakePty implements PtyLike {
  written: string[] = [];
  killed = false;
  private dataCbs: ((d: string) => void)[] = [];
  private exitCbs: ((e: { exitCode: number }) => void)[] = [];
  onData(cb: (d: string) => void) {
    this.dataCbs.push(cb);
  }
  onExit(cb: (e: { exitCode: number }) => void) {
    this.exitCbs.push(cb);
  }
  write(d: string) {
    this.written.push(d);
  }
  kill() {
    this.killed = true;
    this.exit(1);
  }
  emit(d: string) {
    for (const cb of this.dataCbs) cb(d);
  }
  exit(code: number) {
    for (const cb of this.exitCbs) cb({ exitCode: code });
  }
}

const authStatus = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    loggedIn: true,
    authMethod: 'claude.ai',
    apiProvider: 'firstParty',
    email: 'a@example.com',
    subscriptionType: 'max',
    ...over,
  });

function fakeChildEnv(inject: ChildEnvInject): Record<string, string> {
  return { PATH: '/usr/bin', CLAUDE_CONFIG_DIR: inject.configDir ?? '' };
}

function makeStore(accounts: Account[] = []) {
  const state: PersistedState = { version: 1, projects: [], threads: [], accounts, settings: { ...DEFAULT_SETTINGS } };
  return { get: () => state, update: (m: (d: PersistedState) => void) => m(state) };
}

function makeBroadcaster() {
  const events: { ch: EventChannel; payload: unknown }[] = [];
  return {
    events,
    emit<K extends EventChannel>(ch: K, payload: EventPayload<K>) {
      events.push({ ch, payload });
    },
    of(ch: EventChannel) {
      return events.filter((e) => e.ch === ch).map((e) => e.payload);
    },
  };
}

const account = (id: string, priority: number, over: Partial<Account> = {}): Account => ({
  id,
  alias: id,
  color: '#007AFF',
  email: `${id}@example.com`,
  plan: 'max',
  configDir: `/tmp/none/${id}`,
  priority,
  enabled: true,
  createdAt: 1,
  ...over,
});

const flush = () => new Promise((r) => setTimeout(r, 0));

let root: string;
let claudeDir: string;
let accountsDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hopecode-pool-'));
  claudeDir = join(root, 'dot-claude');
  accountsDir = join(root, 'home', 'accounts');
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(join(claudeDir, 'CLAUDE.md'), '# rules');
  mkdirSync(join(claudeDir, 'plugins'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// loginFlow
// ---------------------------------------------------------------------------

describe('loginFlow', () => {
  function flow(runStdout = authStatus(), over: Partial<LoginFlowDeps> = {}) {
    const pty = new FakePty();
    const spawnPty = vi.fn<SpawnPtyFn>(() => pty);
    const runCommand = vi.fn<RunCommandFn>(async () => ({ code: 0, stdout: runStdout }));
    const openExternal = vi.fn();
    const data: string[] = [];
    const childEnv = vi.fn(fakeChildEnv);
    const session = startLoginFlow(
      { claudePath: () => '/bin/claude', childEnv, spawnPty, runCommand, openExternal, ...over },
      { loginId: 'L1', configDir: '/acc/dir', onData: (d) => data.push(d) },
    );
    return { pty, spawnPty, runCommand, openExternal, data, session, childEnv };
  }

  it('spawns `claude auth login --claudeai` with childEnv({configDir}) and reads auth status on exit 0', async () => {
    const f = flow();
    expect(f.childEnv).toHaveBeenCalledWith({ configDir: '/acc/dir' });
    const [file, args, opts] = f.spawnPty.mock.calls[0]!;
    expect(file).toBe('/bin/claude');
    expect(args).toEqual(['auth', 'login', '--claudeai']);
    expect(opts.env).toEqual({ PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/acc/dir' });
    f.pty.exit(0);
    expect(await f.session.done).toEqual({ ok: true, email: 'a@example.com', plan: 'max' });
    const [sFile, sArgs, sOpts] = f.runCommand.mock.calls[0]!;
    expect([sFile, sArgs]).toEqual(['/bin/claude', ['auth', 'status', '--json']]);
    expect(sOpts.env.CLAUDE_CONFIG_DIR).toBe('/acc/dir');
  });

  it('streams output, opens the first OAuth URL once, forwards input', async () => {
    const f = flow();
    f.pty.emit('Opening browser: \x1b[4mhttps://claude.ai/oauth/authorize?code=true&x=');
    expect(f.openExternal).not.toHaveBeenCalled(); // URL may still be split across chunks
    f.pty.emit('1\x1b[24m\r\nPaste code here: ');
    f.pty.emit('again https://claude.ai/other \n');
    expect(f.openExternal).toHaveBeenCalledTimes(1);
    expect(f.openExternal).toHaveBeenCalledWith('https://claude.ai/oauth/authorize?code=true&x=1');
    expect(f.data.join('')).toContain('Paste code here');
    f.session.write('CODE\r');
    expect(f.pty.written).toEqual(['CODE\r']);
    f.pty.exit(0);
    await f.session.done;
  });

  it('non-zero exit, failed status, cancel -> not ok', async () => {
    const a = flow();
    a.pty.exit(2);
    expect(await a.session.done).toMatchObject({ ok: false });
    expect(a.runCommand).not.toHaveBeenCalled();

    const b = flow(authStatus({ loggedIn: false }));
    b.pty.exit(0);
    expect(await b.session.done).toMatchObject({ ok: false });

    const c = flow(authStatus({ authMethod: 'api_key' }));
    c.pty.exit(0);
    expect(await c.session.done).toMatchObject({ ok: false });

    const d = flow();
    d.session.cancel();
    expect(d.pty.killed).toBe(true);
    expect(await d.session.done).toEqual({ ok: false, error: 'cancelled' });
  });

  it('parseAuthStatus handles garbage', () => {
    expect(parseAuthStatus('nope')).toMatchObject({ ok: false });
    expect(parseAuthStatus(authStatus({ email: null, subscriptionType: undefined }))).toEqual({
      ok: true,
      email: null,
      plan: null,
    });
  });
});

// ---------------------------------------------------------------------------
// accountPool
// ---------------------------------------------------------------------------

describe('accountPool', () => {
  function makePool(existing: Account[] = [], statusJson = authStatus()) {
    const store = makeStore(existing);
    const broadcaster = makeBroadcaster();
    const order: string[] = [];
    const ptys: FakePty[] = [];
    const credentials = { invalidate: vi.fn(), deleteKeychainItem: vi.fn(async () => {}) };
    const usageHistory = { remove: vi.fn(async () => {}) };
    const onAccountAdded = vi.fn();
    const spawnPty: SpawnPtyFn = (_f, _a, opts) => {
      order.push(`login:${opts.env.CLAUDE_CONFIG_DIR}`);
      const p = new FakePty();
      ptys.push(p);
      return p;
    };
    const startLogin: StartLoginFn = (input) =>
      startLoginFlow(
        {
          claudePath: () => '/bin/claude',
          childEnv: fakeChildEnv,
          spawnPty,
          runCommand: async () => ({ code: 0, stdout: statusJson }),
        },
        input,
      );
    let n = 0;
    const pool = createAccountPool({
      store,
      accountsDir: () => accountsDir,
      links: {
        linkSharedConfig: async (dir) => {
          order.push(`dir-exists:${existsSync(dir)}`);
          order.push('links');
          return linkSharedConfig(dir, claudeDir, () => {});
        },
      },
      startLogin,
      credentials,
      broadcaster,
      usageHistory,
      onAccountAdded,
      newId: () => `id${++n}`,
      now: () => 42,
    });
    return { pool, store, broadcaster, order, ptys, credentials, usageHistory, onAccountAdded };
  }

  it('creation order: dir (0700) -> links -> login; success persists email/plan and refreshes usage', async () => {
    const t = makePool([account('old', 0)]);
    const { loginId, accountId } = await t.pool.startLogin({ alias: 'Work', color: '#34C759' });
    const dir = join(accountsDir, accountId);
    expect(t.order).toEqual(['dir-exists:true', 'links', `login:${dir}`]);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(dir, 'CLAUDE.md')).isSymbolicLink()).toBe(true);
    expect(t.pool.list().map((a) => a.id)).toEqual(['old']); // not persisted until login succeeds

    t.ptys[0]!.emit('hello');
    expect(t.broadcaster.of('login:data')).toEqual([{ loginId, data: 'hello' }]);
    t.ptys[0]!.exit(0);
    await flush();
    await flush();

    const added = t.pool.get(accountId)!;
    expect(added).toMatchObject({
      alias: 'Work',
      color: '#34C759',
      email: 'a@example.com',
      plan: 'max',
      configDir: dir,
      priority: 1,
      enabled: true,
      createdAt: 42,
    });
    expect(dir.endsWith('/')).toBe(false);
    expect(t.broadcaster.of('login:exit')).toEqual([{ loginId, ok: true, account: added }]);
    expect(t.broadcaster.of('account:updated').at(-1)).toHaveLength(2);
    expect(t.onAccountAdded).toHaveBeenCalledWith(added);
  });

  it('failed login removes the config dir (originals kept)', async () => {
    const t = makePool();
    const { loginId, accountId } = await t.pool.startLogin({ alias: 'x', color: '#000' });
    t.ptys[0]!.exit(1);
    await vi.waitFor(() => expect(t.broadcaster.of('login:exit')).toHaveLength(1));
    expect(existsSync(join(accountsDir, accountId))).toBe(false);
    expect(existsSync(join(claudeDir, 'CLAUDE.md'))).toBe(true);
    expect(t.pool.list()).toEqual([]);
    expect(t.broadcaster.of('login:exit')).toEqual([expect.objectContaining({ loginId, ok: false })]);
  });

  it('cancelLogin kills the pty and cleans up', async () => {
    const t = makePool();
    const { loginId, accountId } = await t.pool.startLogin({ alias: 'x', color: '#000' });
    t.pool.loginInput(loginId, 'abc');
    expect(t.ptys[0]!.written).toEqual(['abc']);
    await t.pool.cancelLogin(loginId);
    expect(t.ptys[0]!.killed).toBe(true);
    expect(existsSync(join(accountsDir, accountId))).toBe(false);
    expect(t.credentials.deleteKeychainItem).toHaveBeenCalledWith(join(accountsDir, accountId));
    expect(t.broadcaster.of('login:exit')).toEqual([{ loginId, ok: false, error: 'cancelled' }]);
  });

  it('rejects an email that is already registered', async () => {
    const t = makePool([account('a', 0, { email: 'A@example.com' })]);
    const { accountId } = await t.pool.startLogin({ alias: 'dup', color: '#000' });
    t.ptys[0]!.exit(0);
    await vi.waitFor(() => expect(t.broadcaster.of('login:exit')).toHaveLength(1));
    expect(t.pool.list().map((a) => a.id)).toEqual(['a']);
    expect(existsSync(join(accountsDir, accountId))).toBe(false);
    expect(t.broadcaster.of('login:exit')[0]).toMatchObject({ ok: false });
  });

  it('update / reorder / remove', async () => {
    const t = makePool([account('a', 0), account('b', 1), account('c', 2)]);
    expect(t.pool.update('b', { alias: 'B', enabled: false })).toMatchObject({ id: 'b', alias: 'B', enabled: false });
    expect(() => t.pool.update('zzz', { alias: 'x' })).toThrow();

    t.pool.reorder(['c', 'a']);
    expect(t.pool.list().map((a) => [a.id, a.priority])).toEqual([
      ['c', 0],
      ['a', 1],
      ['b', 2],
    ]);

    const seen: Account[][] = [];
    t.pool.onChange((acc) => seen.push(acc));

    const dir = join(accountsDir, 'acc-c');
    mkdirSync(dir, { recursive: true });
    await linkSharedConfig(dir, claudeDir, () => {});
    t.store.get().accounts.find((a) => a.id === 'c')!.configDir = dir;
    await t.pool.remove('c', true);
    expect(t.pool.list().map((a) => a.id)).toEqual(['a', 'b']);
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(join(claudeDir, 'CLAUDE.md'))).toBe(true);
    expect(t.credentials.deleteKeychainItem).toHaveBeenCalledWith(dir);
    expect(t.credentials.invalidate).toHaveBeenCalledWith(dir);
    expect(t.usageHistory.remove).toHaveBeenCalledWith('c');
    expect(seen).toHaveLength(1);

    await t.pool.remove('a', false);
    expect(t.credentials.deleteKeychainItem).toHaveBeenCalledTimes(1);

    // (L5) A config dir outside accountsDir is never deleted recursively; the account stays.
    const outside = join(root, 'outside-b');
    mkdirSync(outside);
    t.store.get().accounts.find((a) => a.id === 'b')!.configDir = outside;
    await expect(t.pool.remove('b', true)).rejects.toThrow(/outside/);
    expect(existsSync(outside)).toBe(true);
    expect(t.pool.list().map((a) => a.id)).toEqual(['b']);
  });
});
