// Account CRUD + login orchestration (plan 4.2, 7.1).
// Creation order: config dir (0700) -> linkSharedConfig -> login pty. The account is persisted only
// after a successful login; failure / cancel removes the dir (symlinks unlinked, originals kept).
import { randomUUID } from 'node:crypto';
import { chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Account, AccountPatch } from '../../shared/types';
import type { AccountPool, Broadcaster, ConfigDirLinks, Credentials, Store, Unsubscribe, UsageHistory } from '../contracts';
import { removeConfigDir as defaultRemoveConfigDir } from './configDirLinks';
import { assertInside } from '../containment';
import type { LoginResult, LoginSession } from './loginFlow';

export type StartLoginFn = (input: {
  loginId: string;
  configDir: string;
  onData: (data: string) => void;
}) => LoginSession;

export interface AccountPoolDeps {
  store: Pick<Store, 'get' | 'update'>;
  /** Parent of account config dirs (paths.accountsDir()). */
  accountsDir: () => string;
  links: Pick<ConfigDirLinks, 'linkSharedConfig'>;
  /** Bound loginFlow.startLoginFlow (fake in tests / fixture mode). */
  startLogin: StartLoginFn;
  credentials: Pick<Credentials, 'invalidate' | 'deleteKeychainItem'>;
  broadcaster?: Broadcaster;
  usageHistory?: Pick<UsageHistory, 'remove'>;
  /** Called after a successful login (usagePoller.refresh(accountId)). */
  onAccountAdded?: (account: Account) => void;
  removeConfigDir?: (configDir: string) => Promise<void>;
  newId?: () => string;
  now?: () => number;
}

interface ActiveLogin {
  accountId: string;
  configDir: string;
  alias: string;
  color: string;
  session: LoginSession;
  /** Resolves after complete() finished persisting / cleaning up. */
  completion?: Promise<void>;
}

export function createAccountPool(deps: AccountPoolDeps): AccountPool {
  const newId = deps.newId ?? randomUUID;
  const now = deps.now ?? Date.now;
  const removeDir = deps.removeConfigDir ?? defaultRemoveConfigDir;
  const listeners = new Set<(accounts: Account[]) => void>();
  const logins = new Map<string, ActiveLogin>();

  const list = (): Account[] => [...deps.store.get().accounts].sort((a, b) => a.priority - b.priority);

  function changed(): void {
    const accounts = list();
    deps.broadcaster?.emit('account:updated', accounts);
    for (const cb of listeners) cb(accounts);
  }

  /** Recursive delete of an account config dir, only below accountsDir (L5). */
  async function removeAccountDir(configDir: string): Promise<void> {
    assertInside(deps.accountsDir(), configDir, 'account config dir');
    await removeDir(configDir);
  }

  async function discard(configDir: string): Promise<void> {
    deps.credentials.invalidate(configDir);
    await deps.credentials.deleteKeychainItem(configDir).catch(() => {});
    await removeAccountDir(configDir).catch(() => {});
  }

  async function complete(loginId: string, login: ActiveLogin, result: LoginResult): Promise<void> {
    logins.delete(loginId);
    if (!result.ok) {
      await discard(login.configDir);
      deps.broadcaster?.emit('login:exit', { loginId, ok: false, error: result.error });
      return;
    }
    const dup = result.email
      ? deps.store.get().accounts.find((a) => a.email?.toLowerCase() === result.email!.toLowerCase())
      : undefined;
    if (dup) {
      await discard(login.configDir);
      deps.broadcaster?.emit('login:exit', {
        loginId,
        ok: false,
        error: `${result.email} is already registered as "${dup.alias}".`,
      });
      return;
    }
    const accounts = deps.store.get().accounts;
    const account: Account = {
      id: login.accountId,
      alias: login.alias,
      color: login.color,
      email: result.email,
      plan: result.plan,
      configDir: login.configDir,
      priority: accounts.reduce((m, a) => Math.max(m, a.priority), -1) + 1,
      enabled: true,
      createdAt: now(),
    };
    deps.store.update((draft) => {
      draft.accounts.push(account);
    });
    deps.broadcaster?.emit('login:exit', { loginId, ok: true, account });
    changed();
    deps.onAccountAdded?.(account);
  }

  return {
    list,

    get: (accountId) => deps.store.get().accounts.find((a) => a.id === accountId),

    async startLogin({ alias, color }) {
      const accountId = newId();
      const loginId = newId();
      // Absolute, no trailing slash: hashed verbatim for the Keychain service name.
      const configDir = join(deps.accountsDir(), accountId);
      await mkdir(configDir, { recursive: true, mode: 0o700 });
      await chmod(configDir, 0o700);
      let session: LoginSession;
      try {
        await deps.links.linkSharedConfig(configDir);
        session = deps.startLogin({
          loginId,
          configDir,
          onData: (data) => deps.broadcaster?.emit('login:data', { loginId, data }),
        });
      } catch (err) {
        await removeAccountDir(configDir).catch(() => {});
        throw err;
      }
      const login: ActiveLogin = { accountId, configDir, alias, color, session };
      logins.set(loginId, login);
      login.completion = session.done.then((r) => complete(loginId, login, r));
      return { loginId, accountId };
    },

    loginInput(loginId, data) {
      logins.get(loginId)?.session.write(data);
    },

    async cancelLogin(loginId) {
      const login = logins.get(loginId);
      if (!login) return;
      login.session.cancel();
      await login.completion;
    },

    async cancelAllLogins() {
      const pending = [...logins.values()];
      for (const login of pending) login.session.cancel();
      await Promise.all(pending.map((l) => l.completion));
    },

    update(accountId, patch: AccountPatch) {
      let updated: Account | undefined;
      deps.store.update((draft) => {
        const a = draft.accounts.find((x) => x.id === accountId);
        if (!a) return;
        if (patch.alias !== undefined) a.alias = patch.alias;
        if (patch.color !== undefined) a.color = patch.color;
        if (patch.enabled !== undefined) a.enabled = patch.enabled;
        updated = { ...a };
      });
      if (!updated) throw new Error(`Unknown account: ${accountId}`);
      changed();
      return updated;
    },

    reorder(orderedIds) {
      deps.store.update((draft) => {
        const rank = new Map(orderedIds.map((id, i) => [id, i]));
        const sorted = [...draft.accounts].sort((a, b) => {
          const ra = rank.get(a.id) ?? orderedIds.length + a.priority;
          const rb = rank.get(b.id) ?? orderedIds.length + b.priority;
          return ra - rb;
        });
        sorted.forEach((a, i) => {
          a.priority = i;
        });
      });
      changed();
    },

    async remove(accountId, deleteConfigDir) {
      const account = deps.store.get().accounts.find((a) => a.id === accountId);
      if (!account) return;
      if (deleteConfigDir) assertInside(deps.accountsDir(), account.configDir, 'account config dir');
      deps.store.update((draft) => {
        draft.accounts = draft.accounts.filter((a) => a.id !== accountId);
      });
      deps.credentials.invalidate(account.configDir);
      if (deleteConfigDir) {
        await deps.credentials.deleteKeychainItem(account.configDir).catch(() => {});
        await removeAccountDir(account.configDir);
      }
      await deps.usageHistory?.remove(accountId).catch(() => {});
      changed();
    },

    onChange(cb): Unsubscribe {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
