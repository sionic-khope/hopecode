// The Mac's own Claude Code login as a pool account (plan 2.9.5, `Account.source === 'local-default'`).
// Its configDir is paths.localClaudeDir() (`~/.claude`, or `$HOPECODE_HOME/home/fake-claude` under a dev override).
// It is never deleted (no config dir / Keychain removal) and never gets CLAUDE_CONFIG_DIR: the CLI then reads the
// base Keychain service `Claude Code-credentials`, which is where the local login lives.
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Account, AppSettings, LocalAuthInfo, Thread } from '../../shared/types';
import type { AccountPool, Broadcaster, SessionManager, Store } from '../contracts';
import { isStrictlyInside } from '../containment';
import { devEnv, localClaudeDir } from '../paths';
import type { SyncTranscriptFn } from '../session/transcriptSync';

/** Dev env (ignored when packaged): fixture runs report and enroll a deterministic local account (accounts-local e2e). */
export const ENV_FIXTURE_LOCAL_CLAUDE = 'HOPECODE_FIXTURE_LOCAL_CLAUDE';

/** The single branch point for every local-account difference (env, Keychain, deletion, shared config). */
export function isLocalDefault(account: Pick<Account, 'source'> | null | undefined): boolean {
  return account?.source === 'local-default';
}

/** CLAUDE_CONFIG_DIR to inject for `account`: none for the local account (the CLI would look up a hashed service). */
export function claudeConfigDirFor(account: Pick<Account, 'source' | 'configDir'>): string | undefined {
  return isLocalDefault(account) ? undefined : account.configDir;
}

/**
 * Deletion guard: throws when `configDir` is the local Claude dir or one of its ancestors (deleting it would wipe the
 * user's own Claude Code login). Used by Keychain deletion, removeConfigDir and accountPool's dir removal.
 */
export function assertNotLocalClaudeDir(configDir: string, localDir: string = localClaudeDir()): void {
  // Lexical and symlink-resolved paths: a link to (or into) ~/.claude is refused too.
  for (const [target, local] of [
    [resolve(configDir), resolve(localDir)],
    [realOrResolved(configDir), realOrResolved(localDir)],
  ] as const) {
    // The dir itself, an ancestor of it, or a path inside it.
    if (target === local || isStrictlyInside(target, local) || isStrictlyInside(local, target)) {
      throw new Error(`refusing to delete the local Claude config dir: ${configDir}`);
    }
  }
}

function realOrResolved(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** Fixture runs enroll the local account only with HOPECODE_FIXTURE_LOCAL_CLAUDE=1 (never the real ~/.claude). */
export function localClaudeEnrollAllowed(fixtures: boolean, env: (name: string) => string | undefined = devEnv): boolean {
  return !fixtures || env(ENV_FIXTURE_LOCAL_CLAUDE) === '1';
}

/** AccountPool plus the local-account entry point (createAccountPool returns this). */
export interface LocalDefaultAccountPool extends AccountPool {
  /** Appends the local account (priority max+1, enabled) or returns the one already there. */
  addLocalDefault(input: { email: string | null; plan: string | null }): Account;
}

export type LocalDefaultSyncResult =
  /** Enrolled now. */
  | 'added'
  /** A local account is already in the pool. */
  | 'present'
  /** A managed account with the same email exists (Accounts shows "이미 풀에 같은 계정이 있음"). */
  | 'same-email'
  /** settings.localClaudeInPool is false. */
  | 'off'
  /** Fixture run without HOPECODE_FIXTURE_LOCAL_CLAUDE=1. */
  | 'fixture-off'
  /** The Claude detector did not report a login. */
  | 'not-logged-in';

export interface LocalDefaultSyncDeps {
  pool: Pick<LocalDefaultAccountPool, 'list' | 'addLocalDefault'>;
  settings: () => Pick<AppSettings, 'localClaudeInPool'>;
  fixtures: boolean;
  env?: (name: string) => string | undefined;
}

/** Auto-enrollment rule (plan 2.9.5); run after every Claude detection. */
export function syncLocalDefaultAccount(deps: LocalDefaultSyncDeps, claude: LocalAuthInfo | undefined): LocalDefaultSyncResult {
  if (!localClaudeEnrollAllowed(deps.fixtures, deps.env)) return 'fixture-off';
  if (!deps.settings().localClaudeInPool) return 'off';
  const accounts = deps.pool.list();
  if (accounts.some(isLocalDefault)) return 'present';
  if (!claude || claude.agent !== 'claude-code' || claude.state !== 'logged-in') return 'not-logged-in';
  const email = claude.email?.toLowerCase();
  if (email && accounts.some((a) => a.email?.toLowerCase() === email)) return 'same-email';
  deps.pool.addLocalDefault({ email: claude.email, plan: claude.plan });
  return 'added';
}

export interface AccountRemovalDeps {
  accountPool: Pick<AccountPool, 'get' | 'list' | 'update' | 'remove'>;
  store: Pick<Store, 'get' | 'patchThread'>;
  sessionManager: Pick<SessionManager, 'closeAccount'>;
  syncTranscript: SyncTranscriptFn;
  broadcaster: Broadcaster;
  log?: (message: string, err?: unknown) => void;
}

export type AccountRemovalResult = { ok: true } | { ok: false; error: string };

/**
 * `account:remove` flow: disable -> sessionManager.closeAccount (CLI exit awaited) -> hand dependent threads'
 * transcripts to the first other enabled account (heir) -> accountPool.remove. A failed handoff aborts the removal.
 * The local account is always removed with `deleteConfigDir=false` (pool membership only, ~/.claude untouched).
 */
export async function removeAccountWithHandoff(
  deps: AccountRemovalDeps,
  accountId: string,
  deleteConfigDir: boolean,
): Promise<AccountRemovalResult> {
  const { accountPool, store, broadcaster } = deps;
  const log = deps.log ?? (() => {});
  const account = accountPool.get(accountId);
  if (!account) return { ok: true };
  if (isLocalDefault(account) && deleteConfigDir) {
    log('[accounts] ignoring deleteConfigDir for the local Claude account');
    deleteConfigDir = false;
  }

  // Threads whose freshest transcript lives in this account are handed to another enabled account.
  const dependents = store.get().threads.filter((t) => t.lastAccountId === accountId);
  const heir = accountPool.list().find((a) => a.id !== accountId && a.enabled);
  if (dependents.length > 0 && !heir) {
    return {
      ok: false,
      error: `${account.alias} 계정에 스레드 ${dependents.length}개의 대화 기록이 있습니다. 다른 계정을 추가하거나 활성화한 뒤 제거하세요.`,
    };
  }

  // Disable first so no new turn picks it, then (a) stop its Queries (CLI exit awaited).
  const wasEnabled = account.enabled;
  if (wasEnabled) accountPool.update(accountId, { enabled: false });
  await deps.sessionManager.closeAccount(accountId);

  // (b) copy transcripts to the heir and move lastAccountId. A failed copy aborts the removal: deleting the
  // account (and its config dir) would lose that thread's history.
  for (const thread of store.get().threads) {
    const patch: Partial<Thread> = {};
    if (thread.lastAccountId === accountId && heir) {
      if (thread.sdkSessionId) {
        try {
          await deps.syncTranscript(thread.sdkSessionId, account.configDir, heir.configDir);
        } catch (err) {
          log('[accounts] transcript handoff failed', err);
          if (wasEnabled) accountPool.update(accountId, { enabled: true });
          return {
            ok: false,
            error: `"${thread.title}"의 대화 기록을 ${heir.alias}(으)로 옮기지 못했습니다: ${err instanceof Error ? err.message : String(err)}. ${account.alias} 계정은 제거되지 않았습니다.`,
          };
        }
      }
      patch.lastAccountId = heir.id;
    }
    if (thread.activeAccountId === accountId) patch.activeAccountId = null;
    if (thread.pinnedAccountId === accountId) patch.pinnedAccountId = null;
    if (Object.keys(patch).length > 0) broadcaster.emit('thread:updated', { ...store.patchThread(thread.id, patch) });
  }

  // (c) only now remove the account (and its config dir).
  try {
    await accountPool.remove(accountId, deleteConfigDir);
  } catch (err) {
    return { ok: false, error: `${account.alias} 계정을 제거하지 못했습니다: ${err instanceof Error ? err.message : String(err)}` };
  }
  return { ok: true };
}

export interface SetLocalDefaultDeps extends AccountRemovalDeps, Omit<LocalDefaultSyncDeps, 'pool' | 'settings'> {
  accountPool: Pick<LocalDefaultAccountPool, 'get' | 'list' | 'update' | 'remove' | 'addLocalDefault'>;
  store: Pick<Store, 'get' | 'patchThread' | 'update'>;
  /** Re-runs the Claude detector (LocalAuthService.recheck('claude-code')) and returns its result. */
  recheckClaude: () => Promise<LocalAuthInfo | undefined>;
}

/**
 * `account:setLocalDefault`. include=false: localClaudeInPool=false is saved, then the local account leaves the pool
 * through removeAccountWithHandoff (deleteConfigDir=false); a failed handoff restores true. include=true: save true,
 * re-detect, enroll.
 */
export async function setLocalDefaultInPool(deps: SetLocalDefaultDeps, include: boolean): Promise<AccountRemovalResult> {
  if (!include) {
    // Saved first: a Claude re-detection during the handoff must not re-enroll the account being removed.
    saveInPool(deps, false);
    const local = deps.accountPool.list().find(isLocalDefault);
    if (local) {
      const removed = await removeAccountWithHandoff(deps, local.id, false);
      if (!removed.ok) {
        saveInPool(deps, true);
        return removed;
      }
    }
    return { ok: true };
  }
  saveInPool(deps, true);
  const claude = await deps.recheckClaude();
  syncLocalDefaultAccount(
    { pool: deps.accountPool, settings: () => deps.store.get().settings, fixtures: deps.fixtures, env: deps.env },
    claude,
  );
  return { ok: true };
}

function saveInPool(deps: Pick<SetLocalDefaultDeps, 'store' | 'broadcaster'>, value: boolean): void {
  deps.store.update((draft) => {
    draft.settings.localClaudeInPool = value;
  });
  deps.broadcaster.emit('settings:updated', { ...deps.store.get().settings });
}
