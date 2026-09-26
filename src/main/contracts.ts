// Main-process service interfaces (plan 4.2). Wave 1/2 lanes implement these; index.ts wires them (Wave 3).
// Every service receives dependencies through its constructor/factory; no service imports another lane's module.
import type { query } from '@anthropic-ai/claude-agent-sdk';
import type { EventChannel, EventPayload } from '../shared/ipc';
import type {
  Account,
  AccountPatch,
  AccountUsage,
  ChatItem,
  ChatSendResult,
  ChildEnvInject,
  EditorId,
  EditorInfo,
  EffortLevel,
  GitActionResult,
  GitChanges,
  GitFileDiff,
  GitRemoteInfo,
  ModelOption,
  PermissionDecision,
  PermissionRequest,
  PersistedState,
  PoolSnapshot,
  RateLimitInfoLite,
  Thread,
  UiPermissionMode,
  UsageSample,
  WorktreeInfo,
} from '../shared/types';

export type Unsubscribe = () => void;

/** SDK `query` function; injected so tests / fixture mode can pass a fake. */
export type QueryFn = typeof query;

/** Typed main -> renderer broadcast (implemented by ipc/register over all windows). */
export interface Broadcaster {
  emit<K extends EventChannel>(channel: K, payload: EventPayload<K>): void;
}

// ---------------------------------------------------------------------------
// Environment / binary (1B)
// ---------------------------------------------------------------------------

export interface ShellEnv {
  /** Capture login shell env once (`$SHELL -ilc 'env -0'`, 5s timeout, fallback PATH). */
  init(): Promise<void>;
  /** Base env (after init). */
  baseEnv(): Record<string, string>;
  /** core/childEnv.buildChildEnv(baseEnv, inject). The ONLY env source for SDK / pty / login / auth status. */
  childEnv(inject: ChildEnvInject): Record<string, string>;
}

export interface ClaudeBinary {
  /** Absolute path of the claude executable (asar.unpacked aware, PATH fallback). */
  resolvePath(): string;
  /** SDK manifest.json version (e.g. "2.1.282") or null. */
  getCliVersion(): string | null;
}

// ---------------------------------------------------------------------------
// Persistence (1B)
// ---------------------------------------------------------------------------

export interface Store {
  /** Load/migrate state.json; `running` threads are normalized to `idle`. */
  load(): Promise<PersistedState>;
  get(): PersistedState;
  /** Mutate in place; save is debounced (250ms) with atomic replace. */
  update(mutator: (draft: PersistedState) => void): void;
  getThread(threadId: string): Thread | undefined;
  /** Shallow-merge patch, bump updatedAt, return new thread. Throws when missing. */
  patchThread(threadId: string, patch: Partial<Thread>): Thread;
  /** Force pending debounced save. */
  flush(): Promise<void>;
  onChange(cb: (state: PersistedState) => void): Unsubscribe;
}

export interface ThreadLog {
  /** Append a finalized ChatItem. Re-appending the same id is an upsert (last wins on read). */
  append(threadId: string, item: ChatItem): Promise<void>;
  /** Read items in order, deduplicated by id. */
  read(threadId: string): Promise<ChatItem[]>;
  remove(threadId: string): Promise<void>;
}

export interface UsageHistory {
  /** Append when values changed or >= 5min since last sample. Returns true when written. */
  append(accountId: string, sample: UsageSample): Promise<boolean>;
  read(accountId: string, rangeMs: number, now?: number): Promise<UsageSample[]>;
  /** Drop samples older than 14 days (run at startup). */
  compact(now?: number): Promise<void>;
  remove(accountId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Worktree / pty (1B)
// ---------------------------------------------------------------------------

export interface WorktreeCreateResult {
  cwd: string;
  worktree?: WorktreeInfo;
}

export interface WorktreeManager {
  /** git repo with HEAD -> `git worktree add -b hopecode/<threadShortId>`; otherwise folder as-is. */
  /** `trusted: false` (default) runs the checkout with repo hooks disabled (`core.hooksPath=/dev/null`). */
  create(projectPath: string, threadShortId: string, opts?: { trusted?: boolean }): Promise<WorktreeCreateResult>;
  isDirty(worktreePath: string): Promise<boolean>;
  remove(projectPath: string, worktree: WorktreeInfo, opts: { force: boolean }): Promise<void>;
}

export interface PtyManager {
  /** Spawn (or reuse) the thread shell; returns ring-buffer replay for an existing pty. Emits pty:data / pty:exit. */
  open(threadId: string, cwd: string, cols: number, rows: number): { ptyId: string; replay: string };
  write(threadId: string, data: string): void;
  resize(threadId: string, cols: number, rows: number): void;
  kill(threadId: string): void;
  killAll(): void;
}

// ---------------------------------------------------------------------------
// Accounts & usage (1C)
// ---------------------------------------------------------------------------

export type CredentialsResult =
  | {
      status: 'ok';
      accessToken: string;
      expiresAt: number | null;
      subscriptionType: string | null;
      rateLimitTier: string | null;
    }
  | { status: 'token_expired'; expiresAt: number }
  | { status: 'no_credentials' };

/** Read-only (no refresh, no Keychain write-back). */
export interface Credentials {
  read(configDir: string): Promise<CredentialsResult>;
  invalidate(configDir: string): void;
  /** `security delete-generic-password` for the account's service (account removal). */
  deleteKeychainItem(configDir: string): Promise<void>;
}

export type UsageFetchResult =
  | { status: 'ok'; data: unknown }
  | { status: 'rate_limited'; retryAfterMs: number | null }
  | { status: 'auth' }
  | { status: 'network'; message: string };

export interface UsageClient {
  fetchUsage(accessToken: string, cliVersion: string): Promise<UsageFetchResult>;
}

export interface ConfigDirLinks {
  linkSharedConfig(configDir: string, sourceDir?: string): Promise<{ linked: string[]; skipped: string[] }>;
  verifyLinks(configDir: string): Promise<{ broken: string[] }>;
}

export interface UsagePoller {
  start(): void;
  stop(): void;
  /** Force refresh one or all enabled accounts, then broadcast usage:updated. */
  refresh(accountId?: string): Promise<PoolSnapshot>;
  /** Apply SDK rate_limit_event immediately (core/usageParse.applyRateLimitEvent). */
  reportRateLimit(accountId: string, info: RateLimitInfoLite): void;
  /** Mark account usage.error = 'auth' (SDK authentication_failed). */
  markAuthFailed(accountId: string): void;
  getSnapshot(): PoolSnapshot;
  getUsage(accountId: string): AccountUsage | undefined;
  onUpdate(cb: (snapshot: PoolSnapshot) => void): Unsubscribe;
}

export interface AccountPool {
  list(): Account[];
  get(accountId: string): Account | undefined;
  /** dir (0700) -> linkSharedConfig -> login pty. Emits login:data / login:exit, account:updated. */
  startLogin(input: { alias: string; color: string }): Promise<{ loginId: string; accountId: string }>;
  loginInput(loginId: string, data: string): void;
  cancelLogin(loginId: string): Promise<void>;
  /** Cancel every in-progress login (app quit). */
  cancelAllLogins(): Promise<void>;
  update(accountId: string, patch: AccountPatch): Account;
  reorder(orderedIds: string[]): void;
  remove(accountId: string, deleteConfigDir: boolean): Promise<void>;
  onChange(cb: (accounts: Account[]) => void): Unsubscribe;
}

// ---------------------------------------------------------------------------
// Session (2A)
// ---------------------------------------------------------------------------

export interface SessionManager {
  send(threadId: string, text: string): Promise<ChatSendResult>;
  interrupt(threadId: string): Promise<void>;
  setModel(threadId: string, model: string): Promise<void>;
  setPermissionMode(threadId: string, mode: UiPermissionMode): Promise<void>;
  /** Persist the thread's effort and apply it to the live Query (null = model default). */
  setEffort(threadId: string, effort: EffortLevel | null): Promise<void>;
  respondPermission(requestId: string, decision: PermissionDecision, message?: string): void;
  listModels(): Promise<ModelOption[]>;
  /** Close Query and drop runner (thread deleted). */
  closeThread(threadId: string): Promise<void>;
  /**
   * Stop every use of the account before its config dir goes away: Queries being prepared for it settle
   * (they re-pick another account), its Queries close (CLI exit awaited) and cut turns finish.
   */
  closeAccount(accountId: string): Promise<void>;
  /** Permission requests awaiting an answer (bootstrap re-shows them). */
  pendingPermissions(): PermissionRequest[];
  /** Re-register waiting threads (app start). */
  restore(): void;
  /** Re-evaluate waiting threads now (powerMonitor resume, usage update). */
  reevaluate(): void;
  /** Deny pending permissions, close all Queries. */
  dispose(): Promise<void>;
  /** Hard stop (quit timeout): abort every Query's CLI process without waiting. */
  abortAll(): void;
}

// ---------------------------------------------------------------------------
// Git (changes panel / commit flow)
// ---------------------------------------------------------------------------

/**
 * Git operations for one thread folder. `cwd` is the thread cwd (worktree or project folder); every `path`
 * argument is repo-relative and must resolve inside `cwd` (containment), or the call throws. Every git / gh run
 * uses the injected child env (login-shell PATH, no inherited app env).
 */
export interface GitService {
  /**
   * `projectPath` is the thread's project folder: when `cwd` is a worktree of it, the base is the project folder's
   * checked-out branch (merge-base), otherwise HEAD.
   */
  changes(cwd: string, projectPath: string): Promise<GitChanges>;
  fileDiff(cwd: string, projectPath: string, path: string): Promise<GitFileDiff>;
  /** Tracked file: `git checkout HEAD -- path` (restores deleted / modified; staged changes reset too). Untracked: removed. */
  revertFile(cwd: string, path: string): Promise<GitActionResult>;
  /** `git add -A` then `git commit -m message`. Nothing to commit -> `{ok:false}`. */
  commit(cwd: string, message: string): Promise<GitActionResult<{ sha: string }>>;
  /**
   * Merges the branch checked out in `cwd` into the branch checked out in `projectPath` (`--no-ff`).
   * Refused when `cwd` has uncommitted changes, `projectPath` is dirty, or `cwd` is not a worktree of it.
   * A conflicting merge is aborted (`git merge --abort`) and reported; nothing is left half-merged.
   */
  merge(cwd: string, projectPath: string): Promise<GitActionResult<{ into: string }>>;
  remoteInfo(cwd: string, projectPath: string): Promise<GitRemoteInfo>;
  /** `git push -u <remote> <branch>` then `gh pr create --title --body --base --head`. */
  pushAndOpenPr(cwd: string, projectPath: string, title: string, body: string): Promise<GitActionResult<{ url: string | null }>>;
}

// ---------------------------------------------------------------------------
// External editors
// ---------------------------------------------------------------------------

export interface EditorLauncher {
  /** Installed targets (checked in /Applications and ~/Applications; Finder always). Cached after the first call. */
  list(): Promise<EditorInfo[]>;
  /** `open -a <App> <dir>` (Finder: `open <dir>`). Throws for an editor that is not installed. */
  open(editor: EditorId, dir: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Misc seams
// ---------------------------------------------------------------------------

export type TrustChoice = 'trust' | 'dont-trust' | 'cancel';

/** Native dialog seam (fixture mode returns HOPECODE_FIXTURE_PROJECT and auto-approves confirmations). */
export interface Dialogs {
  pickProjectFolder(): Promise<string | null>;
  /** "Trust this folder?" (Trust / Don't Trust / Cancel). */
  confirmTrustProject(path: string): Promise<TrustChoice>;
  /** Warning before enabling bypassPermissions; Cancel is the default button. */
  confirmBypassPermissions(): Promise<boolean>;
  /** Multi-select file picker ("파일 첨부"), opened at `defaultPath`. Absolute paths; `[]` when cancelled. */
  pickFiles(defaultPath: string): Promise<string[]>;
}

