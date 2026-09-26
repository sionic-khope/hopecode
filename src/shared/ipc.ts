// IPC contract (plan 3.3). Every renderer <-> main message passes through these types.
import type {
  Account,
  AccountPatch,
  AppInfo,
  AppSettings,
  BootstrapPayload,
  EditorId,
  EditorInfo,
  GitActionResult,
  GitChanges,
  GitFileDiff,
  GitRemoteInfo,
  SettingsPatch,
  SharedConfigStatus,
  ChatEvent,
  ChatItem,
  ChatSendResult,
  EffortLevel,
  ModelOption,
  PermissionDecision,
  PermissionRequest,
  PoolSnapshot,
  Project,
  Thread,
  ThreadStartRequest,
  ThreadStartResult,
  UiPermissionMode,
  UsageSample,
} from './types';

/** renderer -> main (`ipcRenderer.invoke`). `req: void` means no argument. */
export interface InvokeMap {
  'app:bootstrap': { req: void; res: BootstrapPayload };
  'project:add': { req: void; res: Project | null };
  'project:remove': { req: { projectId: string }; res: void };
  /** Turning trust on shows a native confirm dialog in main; the returned project carries the applied value. */
  'project:setTrusted': { req: { projectId: string; trusted: boolean }; res: Project };
  'thread:create': {
    req: { projectId: string; title?: string; model?: string; permissionMode?: UiPermissionMode };
    res: Thread;
  };
  /**
   * Draft -> real thread in one step: creates the thread (+ worktree) in `projectId`, titles it from `text` and
   * sends `text` as its first message. Nothing is created when the send is refused (`ok: false`).
   * `bypassPermissions` goes through the same native confirm as `thread:setPermissionMode`.
   */
  'thread:start': { req: ThreadStartRequest; res: ThreadStartResult };
  'thread:rename': { req: { threadId: string; title: string }; res: void };
  'thread:setPinned': { req: { threadId: string; pinned: boolean }; res: void };
  /** Archived threads are hidden from the project lists; nothing is deleted. */
  'thread:setArchived': { req: { threadId: string; archived: boolean }; res: void };
  /** `null` = the model's default effort. Applied to the live Query (applyFlagSettings) and every later one. */
  'thread:setEffort': { req: { threadId: string; effort: EffortLevel | null }; res: void };
  /**
   * `removeWorktree` with a dirty worktree and no `force` deletes nothing and returns `worktree-dirty`;
   * the renderer confirms with the user and re-sends with `force: true`.
   */
  'thread:delete': {
    req: { threadId: string; removeWorktree: boolean; force?: boolean };
    res: { ok: true } | { ok: false; reason: 'worktree-dirty' };
  };
  'thread:setModel': { req: { threadId: string; model: string }; res: void };
  /** `bypassPermissions` needs a native confirm in main; the applied mode always arrives via `thread:updated`. */
  'thread:setPermissionMode': { req: { threadId: string; mode: UiPermissionMode }; res: void };
  'thread:pinAccount': { req: { threadId: string; accountId: string | null }; res: void };
  'chat:history': { req: { threadId: string }; res: ChatItem[] };
  'chat:send': { req: { threadId: string; text: string }; res: ChatSendResult };
  'chat:interrupt': { req: { threadId: string }; res: void };
  'permission:respond': {
    req: { requestId: string; decision: PermissionDecision; message?: string };
    res: void;
  };
  'models:list': { req: void; res: ModelOption[] };
  /**
   * Native file picker for "파일 첨부". Returns `@`-mention paths: relative to the thread cwd (or the project
   * folder for a draft) when inside it, absolute otherwise. `[]` when cancelled.
   */
  'dialog:pickFiles': { req: { threadId?: string; projectId?: string }; res: string[] };
  'account:loginStart': { req: { alias: string; color: string }; res: { loginId: string; accountId: string } };
  'account:loginInput': { req: { loginId: string; data: string }; res: void };
  'account:loginCancel': { req: { loginId: string }; res: void };
  'account:update': { req: { accountId: string; patch: AccountPatch }; res: Account };
  'account:reorder': { req: { orderedIds: string[] }; res: void };
  /** Refused (`ok: false`) when threads depend on the account's transcripts and no other enabled account remains. */
  'account:remove': {
    req: { accountId: string; deleteConfigDir: boolean };
    res: { ok: true } | { ok: false; error: string };
  };
  'usage:refresh': { req: { accountId?: string }; res: PoolSnapshot };
  'usage:history': { req: { accountId: string; rangeMs: number }; res: UsageSample[] };
  'pty:open': { req: { threadId: string; cols: number; rows: number }; res: { ptyId: string; replay: string } };
  'pty:write': { req: { threadId: string; data: string }; res: void };
  'pty:resize': { req: { threadId: string; cols: number; rows: number }; res: void };

  /** Validated partial update; main applies it (poller interval, rotation, worktrees, defaults) and broadcasts it. */
  'settings:update': { req: SettingsPatch; res: AppSettings };
  'app:info': { req: void; res: AppInfo };
  /** Reveals the app data folder (fixed path; nothing else can be opened) in Finder. */
  'app:openDataFolder': { req: void; res: void };
  'app:quit': { req: void; res: void };
  /** ~/.claude entries shared into the account config dirs and their link state per account. */
  'config:sharedStatus': { req: void; res: SharedConfigStatus };
  /** Re-runs the shared-config linking for every account, then reports the new state. */
  'config:relink': { req: void; res: SharedConfigStatus };
  /** Deletes every archived thread (history, runner, worktree even when dirty). */
  'threads:deleteArchived': { req: void; res: { deleted: number } };

  /** Editors / terminals installed in /Applications (Finder always). */
  'editor:list': { req: void; res: EditorInfo[] };
  /** Opens the thread's folder (its cwd, nothing else) in `editor`. */
  'editor:open': { req: { threadId: string; editor: EditorId }; res: void };

  /** Changed files of the thread folder (worktree: against the base branch's merge-base, plus uncommitted work). */
  'git:changes': { req: { threadId: string }; res: GitChanges };
  'git:fileDiff': { req: { threadId: string; path: string }; res: GitFileDiff };
  /** Discards the file's uncommitted changes (tracked: checkout, untracked: removed). The renderer confirms first. */
  'git:revertFile': { req: { threadId: string; path: string }; res: GitActionResult };
  /** `git add -A && git commit -m message` in the thread folder. */
  'git:commit': { req: { threadId: string; message: string }; res: GitActionResult<{ sha: string }> };
  /** Merges the worktree branch into the project's checked-out branch; refused when either side is dirty. */
  'git:merge': { req: { threadId: string }; res: GitActionResult<{ into: string }> };
  'git:remoteInfo': { req: { threadId: string }; res: GitRemoteInfo };
  /** Pushes the branch to its remote and opens a PR with `gh`. The renderer shows a confirm with the target first. */
  'git:pushPr': { req: { threadId: string; title: string; body: string }; res: GitActionResult<{ url: string | null }> };
}

/** main -> renderer (`webContents.send`). */
export interface EventMap {
  'chat:event': { threadId: string; event: ChatEvent };
  'thread:updated': Thread;
  'permission:request': PermissionRequest;
  'permission:cancel': { requestId: string };
  'usage:updated': PoolSnapshot;
  'account:updated': Account[];
  'login:data': { loginId: string; data: string };
  'login:exit': { loginId: string; ok: boolean; account?: Account; error?: string };
  'pty:data': { threadId: string; data: string };
  'pty:exit': { threadId: string; code: number };
  /** Menu View > Toggle Terminal (⌘J); the renderer has no keydown handler for it. */
  'ui:toggleTerminal': void;
  /** Menu File > New Chat (⌘N). */
  'ui:newThread': void;
  /** Menu View > Toggle Sidebar (⌘B). */
  'ui:toggleSidebar': void;
  /** Model list refreshed (startup probe or a live session's supportedModels()). */
  'models:updated': ModelOption[];
  'settings:updated': AppSettings;
  /** App menu > 설정… (⌘,). */
  'ui:openSettings': void;
  /** Menu View > 명령 팔레트 (⌘K). */
  'ui:commandPalette': void;
  /** Menu View > 변경사항 패널 (⌘⇧D). */
  'ui:toggleChanges': void;
}

export type InvokeChannel = keyof InvokeMap;
export type EventChannel = keyof EventMap;
export type InvokeRequest<K extends InvokeChannel> = InvokeMap[K]['req'];
export type InvokeResponse<K extends InvokeChannel> = InvokeMap[K]['res'];
export type EventPayload<K extends EventChannel> = EventMap[K];

// `satisfies` keeps the arrays exhaustive: adding a channel to the map without listing it fails typecheck.
export const INVOKE_CHANNELS = [
  'app:bootstrap',
  'project:add',
  'project:remove',
  'project:setTrusted',
  'thread:create',
  'thread:start',
  'thread:rename',
  'thread:setPinned',
  'thread:setArchived',
  'thread:setEffort',
  'thread:delete',
  'thread:setModel',
  'thread:setPermissionMode',
  'thread:pinAccount',
  'chat:history',
  'chat:send',
  'chat:interrupt',
  'permission:respond',
  'models:list',
  'dialog:pickFiles',
  'account:loginStart',
  'account:loginInput',
  'account:loginCancel',
  'account:update',
  'account:reorder',
  'account:remove',
  'usage:refresh',
  'usage:history',
  'pty:open',
  'pty:write',
  'pty:resize',
  'settings:update',
  'app:info',
  'app:openDataFolder',
  'app:quit',
  'config:sharedStatus',
  'config:relink',
  'threads:deleteArchived',
  'editor:list',
  'editor:open',
  'git:changes',
  'git:fileDiff',
  'git:revertFile',
  'git:commit',
  'git:merge',
  'git:remoteInfo',
  'git:pushPr',
] as const satisfies readonly InvokeChannel[];

export const EVENT_CHANNELS = [
  'chat:event',
  'thread:updated',
  'permission:request',
  'permission:cancel',
  'usage:updated',
  'account:updated',
  'login:data',
  'login:exit',
  'pty:data',
  'pty:exit',
  'ui:toggleTerminal',
  'ui:newThread',
  'ui:toggleSidebar',
  'models:updated',
  'settings:updated',
  'ui:openSettings',
  'ui:commandPalette',
  'ui:toggleChanges',
] as const satisfies readonly EventChannel[];

type Missing<All, Listed> = Exclude<All, Listed>;
// Compile-time exhaustiveness: these resolve to `true` only when every channel is listed.
const invokeExhaustive: Missing<InvokeChannel, (typeof INVOKE_CHANNELS)[number]> extends never ? true : false = true;
const eventExhaustive: Missing<EventChannel, (typeof EVENT_CHANNELS)[number]> extends never ? true : false = true;
void invokeExhaustive;
void eventExhaustive;

const invokeSet: ReadonlySet<string> = new Set(INVOKE_CHANNELS);
const eventSet: ReadonlySet<string> = new Set(EVENT_CHANNELS);

export function isInvokeChannel(ch: unknown): ch is InvokeChannel {
  return typeof ch === 'string' && invokeSet.has(ch);
}

export function isEventChannel(ch: unknown): ch is EventChannel {
  return typeof ch === 'string' && eventSet.has(ch);
}

/** Shape exposed on `window.hopecode` by the preload script. */
export interface HopecodeApi {
  invoke<K extends InvokeChannel>(
    channel: K,
    ...req: InvokeRequest<K> extends void ? [] : [InvokeRequest<K>]
  ): Promise<InvokeResponse<K>>;
  on<K extends EventChannel>(channel: K, cb: (payload: EventPayload<K>) => void): () => void;
}
