// IPC contract (plan 3.3). Every renderer <-> main message passes through these types.
import type {
  Account,
  AccountPatch,
  AcpControls,
  AgentKind,
  AgentUsageSnapshot,
  AppInfo,
  AppSettings,
  AttachResult,
  BootstrapPayload,
  EditorId,
  EditorInfo,
  GitActionResult,
  GitChanges,
  GitFileDiff,
  GitRemoteInfo,
  LocalAuthInfo,
  SettingsPatch,
  SharedConfigStatus,
  SlashCommandList,
  ChatEvent,
  ChatImage,
  ChatItem,
  ChatSendResult,
  CodexEffortLevel,
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
import type { PluginInventory, PullRequestList, Schedule, ScheduleInput } from './nav';
import type {
  NoteAiEvent,
  NoteAiStartRequest,
  NoteChange,
  NoteCardMark,
  NoteChatItem,
  NoteDirListing,
  NoteEntry,
  NoteFile,
  NoteGitStatus,
  NoteSearchResult,
} from './notes';
import type { ThemeOverlay } from './theme';

/** renderer -> main (`ipcRenderer.invoke`). `req: void` means no argument. */
export interface InvokeMap {
  'app:bootstrap': { req: void; res: BootstrapPayload };
  /** First user message per thread id (⌘K thread search); threads without one are left out. */
  'nav:threadFirstMessages': { req: void; res: Record<string, string> };
  /** Open PRs (`gh pr list`) of every registered project that has a remote. */
  'prs:list': { req: void; res: PullRequestList };
  /** Opens a PR page in the browser: https github.com URLs only; false when refused. */
  'prs:openExternal': { req: { url: string }; res: boolean };
  'schedule:list': { req: void; res: Schedule[] };
  /** Creates (no `id`) or replaces a schedule. Validated in main (bypassPermissions is refused). */
  'schedule:save': { req: { id?: string; schedule: ScheduleInput }; res: Schedule };
  'schedule:setEnabled': { req: { id: string; enabled: boolean }; res: Schedule };
  'schedule:delete': { req: { id: string }; res: void };
  /** Read-only inventory of the shared ~/.claude (plugins, skills, agents, output styles, MCP, hooks). */
  'plugins:list': { req: void; res: PluginInventory };
  /** Reveals the shared ~/.claude folder in Finder (fixed path; a no-op in test runs). */
  'plugins:openFolder': { req: void; res: void };
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
  'thread:setEffort': { req: { threadId: string; effort: EffortLevel | CodexEffortLevel | null }; res: void };
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
  /** ACP threads (Hermes mode chip): a mode id the session reported. Full-access-like modes need a native confirm. */
  'thread:setAgentMode': { req: { threadId: string; modeId: string }; res: void };
  /** ACP threads: `session/set_config_option` (Codex model / effort chips). */
  'thread:setAgentConfig': { req: { threadId: string; configId: string; value: string | boolean }; res: void };
  'chat:history': { req: { threadId: string }; res: ChatItem[] };
  /**
   * `images`: inline images (retry of an earlier message; image content blocks, at most 10, 5 MB each).
   * `attachmentIds`: composer attachments main validated (`attach:*`); unknown ids / ones the agent cannot take are
   * refused with `reason: 'attachment'`.
   */
  'chat:send': { req: { threadId: string; text: string; images?: ChatImage[]; attachmentIds?: string[] }; res: ChatSendResult };
  /**
   * Composer "파일 첨부": main opens the native file picker (at the thread / project folder) and reads the chosen
   * files itself; the renderer never names a path. Empty result when cancelled.
   */
  'attach:pick': { req: { threadId?: string; projectId?: string }; res: AttachResult };
  /** Pasted (⌘V) files: bytes only (no path), checked by extension + magic bytes and size in main. */
  'attach:paste': { req: { files: { name: string; bytes: Uint8Array }[] }; res: AttachResult };
  /**
   * Dropped files. Preload-only (the renderer's `invoke` refuses it): preload resolves each File's path with
   * webUtils.getPathForFile, so only files the user actually dropped reach main; path-less ones go as bytes.
   */
  'attach:drop': { req: { paths: string[]; files: { name: string; bytes: Uint8Array }[] }; res: AttachResult };
  /**
   * Image as a `data:` URL: a file inside the thread folder (`path`, relative or absolute, 10 MB max) or an agent
   * image of the thread's media store (`ref`, see ChatImage.ref).
   */
  'image:read': { req: { threadId: string; path?: string; ref?: string }; res: { dataUrl: string } };
  /** Reveals an image file inside the thread folder in Finder. */
  'image:reveal': { req: { threadId: string; path: string }; res: void };
  /** Copies an image to the clipboard: a file inside the thread folder (`path`), or an inline chat image. */
  'image:copy': { req: { threadId: string; path?: string; image?: ChatImage; ref?: string }; res: void };
  /** Lightbox "저장": save dialog for the same sources as `image:copy`; `saved: false` when cancelled. */
  'image:save': { req: { threadId: string; path?: string; image?: ChatImage; ref?: string }; res: { saved: boolean } };
  'chat:interrupt': { req: { threadId: string }; res: void };
  'permission:respond': {
    req: { requestId: string; decision: PermissionDecision; message?: string };
    res: void;
  };
  'models:list': { req: void; res: ModelOption[] };
  /**
   * Claude Code slash commands for the composer's `/` picker: the thread's live session list (supportedCommands)
   * merged with a read-only scan of ~/.claude and, for a trusted project, <folder>/.claude. Draft: `projectId`.
   */
  'commands:list': { req: { threadId?: string; projectId?: string }; res: SlashCommandList };
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
  /**
   * Local Claude login in the account pool: `include: false` takes the `account:remove` path with the config dir
   * and Keychain always kept; `include: true` re-detects and adds it back.
   */
  'account:setLocalDefault': { req: { include: boolean }; res: { ok: true } | { ok: false; error: string } };
  'usage:refresh': { req: { accountId?: string }; res: PoolSnapshot };
  /** Cached local login detection of every agent (no secrets). */
  'agents:list': { req: void; res: LocalAuthInfo[] };
  /** Re-detects one agent (or all); the 재확인 button. Also broadcast as `agents:updated`. */
  'agents:recheck': { req: { agent?: AgentKind }; res: LocalAuthInfo[] };
  /** Fetches the agent's account usage now (null = unavailable). */
  'agentUsage:refresh': { req: { agent: AgentKind }; res: AgentUsageSnapshot | null };
  /** Agent of the selected thread (null = none): its usage is polled every 5 minutes while selected. */
  'agentUsage:setActive': { req: { agent: AgentKind | null }; res: void };
  'usage:history': { req: { accountId: string; rangeMs: number }; res: UsageSample[] };
  /** `projectId` is only consulted for the draft session (`threadId: 'draft'`): its project's folder becomes
   *  the shell's cwd, falling back to the user's home folder when omitted or unknown. Ignored for a real thread
   *  (its own cwd is used). */
  'pty:open': {
    req: { threadId: string; cols: number; rows: number; projectId?: string };
    res: { ptyId: string; replay: string };
  };
  /** Kills the session's shell (if any) and spawns a fresh one in the same cwd (same `projectId` rule as
   *  `pty:open`). The old shell's late exit is not broadcast (the id already maps to the new shell). */
  'pty:restart': {
    req: { threadId: string; cols: number; rows: number; projectId?: string };
    res: { ptyId: string };
  };
  'pty:write': { req: { threadId: string; data: string }; res: void };
  'pty:resize': { req: { threadId: string; cols: number; rows: number }; res: void };

  /** Validated partial update; main applies it (poller interval, rotation, worktrees, defaults) and broadcasts it. */
  'settings:update': { req: SettingsPatch; res: AppSettings };
  'app:info': { req: void; res: AppInfo };
  /** Slots of the local theme folder that hold a file (hopecode-theme:// URLs) and its validated palette. */
  'theme:overlay': { req: void; res: ThemeOverlay };
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
  /**
   * Opens the thread's folder (its cwd) in `editor`, or with `path` one file inside it (relative to the cwd;
   * main refuses anything that resolves outside). Finder reveals the file instead of opening it.
   */
  'editor:open': { req: { threadId: string; editor: EditorId; path?: string }; res: void };

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
  /** `git switch -c name` in the thread's worktree (worktree threads only; the name is validated in main). */
  'git:createBranch': { req: { threadId: string; name: string }; res: GitActionResult<{ branch: string }> };
  /**
   * "공유 > Markdown으로 내보내기": main renders the stored transcript and writes it where the save dialog says.
   * The renderer never sends a path. `ok: false` without `error` = the dialog was cancelled.
   */
  'thread:exportMarkdown': { req: { threadId: string }; res: { ok: true; path: string } | { ok: false; error?: string } };

  // 노트 모드: paths are relative to the active vault (settings.activeNoteVault); main contains every one of them.
  /** Native folder picker; the chosen folder is registered and becomes the active vault. Unchanged when cancelled. */
  'notes:addVault': { req: void; res: AppSettings };
  /** Switches to a registered vault (absolute path from settings.noteVaults). */
  'notes:selectVault': { req: { path: string }; res: AppSettings };
  /** Unregisters a vault (nothing on disk is touched). */
  'notes:removeVault': { req: { path: string }; res: AppSettings };
  /** One folder level of the active vault (`dir: ''` = its root): folders and `.md` files, hidden folders left out. */
  'notes:listDir': { req: { dir: string }; res: NoteDirListing };
  /** `.md` files of the active vault whose name contains `query` (case-insensitive). */
  'notes:search': { req: { query: string }; res: NoteSearchResult };
  'notes:read': { req: { path: string }; res: NoteFile };
  /** Atomic write (temp file + rename) of an existing or new `.md` file, 2 MB max. */
  'notes:write': { req: { path: string; text: string }; res: { mtimeMs: number } };
  /** New empty `.md` file (`.md` appended when missing) or folder; refused when the name exists. */
  'notes:create': { req: { path: string; kind: 'file' | 'dir' }; res: NoteEntry };
  /** Renames inside the same folder (`name` is a single segment; files keep `.md`). */
  'notes:rename': { req: { path: string; name: string }; res: NoteEntry };
  /** Moves a file or folder to the Trash. The renderer confirms first. */
  'notes:trash': { req: { path: string }; res: void };
  /** A link in a note: opened in the browser (https only); false when refused. */
  'notes:openLink': { req: { url: string }; res: boolean };
  /** No git process runs until the user turned git on for the active vault (`notes:enableGit`). */
  'notes:gitStatus': { req: void; res: NoteGitStatus };
  /** The user confirmed git for the active vault (first 커밋): stored in settings.noteGitVaults. */
  'notes:enableGit': { req: void; res: AppSettings };
  /** `git add` + `git commit` of the changed `.md` files of the active vault only. Never pushes. */
  'notes:commit': { req: { message: string }; res: GitActionResult<{ sha: string; files: number }> };
  /** The note's AI conversation (stored in the app data folder, never in the vault). */
  'notes:chat': { req: { path: string }; res: NoteChatItem[] };
  /** What the user did with a card of an answer (applied / taken back); null clears it. */
  'notes:chatCard': { req: { path: string; itemId: string; card: number; mark: NoteCardMark | null }; res: boolean };
  /** Starts a note AI request; its text streams as `notes:ai` events. */
  'notes:aiStart': { req: NoteAiStartRequest; res: { ok: true } | { ok: false; error: string } };
  /** Stops a running request; what streamed so far stays. */
  'notes:aiStop': { req: { requestId: string }; res: void };
}

/** main -> renderer (`webContents.send`). */
export interface EventMap {
  'chat:event': { threadId: string; event: ChatEvent };
  /** Schedules changed (saved, toggled, run, judged missed). */
  'schedule:updated': Schedule[];
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
  /** Menu File > New Task Start (⌘⇧N). */
  'ui:newTaskStart': void;
  /** Local agent login detection changed. */
  'agents:updated': LocalAuthInfo[];
  /** An ACP thread's session modes / config options changed. */
  'agent:controls': { threadId: string; controls: AcpControls };
  /** An agent's account usage changed (null = unavailable, hide the meters). */
  'agentUsage:updated': { agent: AgentKind; snapshot: AgentUsageSnapshot | null };
  /** Files of the active vault changed on disk (fs watch, debounced). */
  'notes:changed': NoteChange;
  /** Streamed text / end of a note AI request. */
  'notes:ai': NoteAiEvent;
}

export type InvokeChannel = keyof InvokeMap;
export type EventChannel = keyof EventMap;
export type InvokeRequest<K extends InvokeChannel> = InvokeMap[K]['req'];
export type InvokeResponse<K extends InvokeChannel> = InvokeMap[K]['res'];
export type EventPayload<K extends EventChannel> = EventMap[K];

// `satisfies` keeps the arrays exhaustive: adding a channel to the map without listing it fails typecheck.
export const INVOKE_CHANNELS = [
  'app:bootstrap',
  'nav:threadFirstMessages',
  'prs:list',
  'prs:openExternal',
  'schedule:list',
  'schedule:save',
  'schedule:setEnabled',
  'schedule:delete',
  'plugins:list',
  'plugins:openFolder',
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
  'thread:setAgentMode',
  'thread:setAgentConfig',
  'chat:history',
  'chat:send',
  'attach:pick',
  'attach:paste',
  'attach:drop',
  'image:read',
  'image:reveal',
  'image:copy',
  'image:save',
  'chat:interrupt',
  'permission:respond',
  'models:list',
  'commands:list',
  'dialog:pickFiles',
  'account:loginStart',
  'account:loginInput',
  'account:loginCancel',
  'account:update',
  'account:reorder',
  'account:remove',
  'account:setLocalDefault',
  'usage:refresh',
  'usage:history',
  'agents:list',
  'agents:recheck',
  'agentUsage:refresh',
  'agentUsage:setActive',
  'pty:open',
  'pty:restart',
  'pty:write',
  'pty:resize',
  'settings:update',
  'app:info',
  'theme:overlay',
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
  'git:createBranch',
  'thread:exportMarkdown',
  'notes:addVault',
  'notes:selectVault',
  'notes:removeVault',
  'notes:listDir',
  'notes:search',
  'notes:read',
  'notes:write',
  'notes:create',
  'notes:rename',
  'notes:trash',
  'notes:openLink',
  'notes:gitStatus',
  'notes:commit',
  'notes:chat',
  'notes:chatCard',
  'notes:aiStart',
  'notes:aiStop',
  'notes:enableGit',
] as const satisfies readonly InvokeChannel[];

export const EVENT_CHANNELS = [
  'chat:event',
  'schedule:updated',
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
  'ui:newTaskStart',
  'agents:updated',
  'agent:controls',
  'agentUsage:updated',
  'notes:changed',
  'notes:ai',
] as const satisfies readonly EventChannel[];

type Missing<All, Listed> = Exclude<All, Listed>;
// Compile-time exhaustiveness: these resolve to `true` only when every channel is listed.
const invokeExhaustive: Missing<InvokeChannel, (typeof INVOKE_CHANNELS)[number]> extends never ? true : false = true;
const eventExhaustive: Missing<EventChannel, (typeof EVENT_CHANNELS)[number]> extends never ? true : false = true;
void invokeExhaustive;
void eventExhaustive;

/** Registered in main but never callable through `window.hopecode.invoke` (preload calls them itself). */
export const PRELOAD_ONLY_CHANNELS: readonly InvokeChannel[] = ['attach:drop'];

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
  /** Files dropped on the composer -> `attach:drop` (paths resolved in preload with webUtils.getPathForFile). */
  attachDropped(files: File[]): Promise<AttachResult>;
}
