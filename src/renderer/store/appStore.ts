// zustand app store (plan 4.4 `store/appStore.ts`): initialized from the `app:bootstrap` payload,
// updated by main -> renderer broadcasts (wired in `store/events.ts`), and the single place
// renderer components dispatch IPC actions from.
import { create } from 'zustand';
import { invoke } from '../api';
import type { InvokeResponse } from '../../shared/ipc';
import { DEFAULT_SETTINGS } from '../../shared/constants';
import { DEFAULT_AGENT } from '../../shared/agents';
import { fillNewTaskTemplate } from '../../core/newTaskTemplate';
import type {
  Account,
  AccountPatch,
  AgentKind,
  AppSettings,
  BootstrapPayload,
  ChatEvent,
  ChatItem,
  ChatSendResult,
  EffortLevel,
  ModelOption,
  PermissionDecision,
  PermissionRequest,
  PoolSnapshot,
  Project,
  SettingsPatch,
  Thread,
  ThreadStartResult,
  UiPermissionMode,
  UsageSample,
} from '../../shared/types';

/** Settings of the unsent "new chat" (draft) the composer edits before `thread:start` creates the thread. */
export interface DraftState {
  projectId: string | null;
  /** Agent the thread will run with (the picker above the draft composer). */
  agent: AgentKind;
  model: string;
  permissionMode: UiPermissionMode;
  effort: EffortLevel | null;
  pinnedAccountId: string | null;
}

const SIDEBAR_COLLAPSED_KEY = 'hopecode.sidebarCollapsed';
const PANEL_WIDTH_KEY = 'hopecode.panelWidth';
export const PANEL_MIN_WIDTH = 320;
export const PANEL_MAX_WIDTH = 820;
export const PANEL_DEFAULT_WIDTH = 460;

/** Right panel width, clamped; per-viewer convenience (localStorage, guarded). */
export function clampPanelWidth(width: number): number {
  if (!Number.isFinite(width)) return PANEL_DEFAULT_WIDTH;
  return Math.round(Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, width)));
}

function readPanelWidth(): number {
  try {
    const raw = globalThis.localStorage?.getItem(PANEL_WIDTH_KEY);
    return raw ? clampPanelWidth(Number(raw)) : PANEL_DEFAULT_WIDTH;
  } catch {
    return PANEL_DEFAULT_WIDTH;
  }
}

function writePanelWidth(width: number): void {
  try {
    globalThis.localStorage?.setItem(PANEL_WIDTH_KEY, String(width));
  } catch {
    // Not persisted; the width still applies for this session.
  }
}

/** Per-viewer convenience only: storage may be unavailable (private mode, tests), so every access is guarded. */
function readSidebarCollapsed(): boolean {
  try {
    return globalThis.localStorage?.getItem(SIDEBAR_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

function writeSidebarCollapsed(collapsed: boolean): void {
  try {
    globalThis.localStorage?.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch {
    // Not persisted; the toggle still works for this session.
  }
}

/**
 * Folder a new draft starts in: the project of the most recently active thread, else the newest project, else
 * none (the composer then asks for a folder).
 */
export function defaultDraftProjectId(projects: readonly Project[], threads: readonly Thread[]): string | null {
  const known = new Set(projects.map((p) => p.id));
  let best: Thread | null = null;
  for (const t of threads) {
    if (!known.has(t.projectId)) continue;
    if (!best || t.updatedAt > best.updatedAt) best = t;
  }
  if (best) return best.projectId;
  let newest: Project | null = null;
  for (const p of projects) if (!newest || p.createdAt >= newest.createdAt) newest = p;
  return newest?.id ?? null;
}

export type Route = 'chat' | 'accounts' | 'settings';

/** Right panel tab (null = panel closed). */
export type PanelTab = 'changes' | 'terminal';

/** App-level modal opened from the profile menu / palette. */
export type AppModal = 'shortcuts' | 'about';

/**
 * Text to place in a composer (suggested prompt, "편집해서 다시 보내기", "New Task Start"). `target` is a thread id
 * or 'draft'; `nonce` makes a repeat of the same text still apply. `mode: 'prepend'` keeps whatever the box already
 * held, with `text` placed in front (New Task Start); the default `'replace'` overwrites it.
 */
export interface ComposerPrefill {
  target: string;
  text: string;
  nonce: number;
  mode?: 'replace' | 'prepend';
}

export interface LoginSessionState {
  output: string;
  done: boolean;
  ok: boolean | null;
  account: Account | null;
  error: string | null;
}

export interface PtyStatus {
  ptyId: string | null;
  running: boolean;
  lastExitCode: number | null;
}

const EMPTY_POOL: PoolSnapshot = {
  summary: {
    avg: { fiveHour: null, sevenDay: null, fable: null },
    earliestReset: { fiveHour: null, sevenDay: null, fable: null },
    available: 0,
    total: 0,
  },
  usageById: {},
  at: 0,
};

const EMPTY_SETTINGS: AppSettings = { ...DEFAULT_SETTINGS };

function upsertThread(threads: Thread[], thread: Thread): Thread[] {
  const idx = threads.findIndex((t) => t.id === thread.id);
  if (idx === -1) return [...threads, thread];
  const next = threads.slice();
  next[idx] = thread;
  return next;
}

function patchThreadLocal(threads: Thread[], threadId: string, patch: Partial<Thread>): Thread[] {
  const idx = threads.findIndex((t) => t.id === threadId);
  if (idx === -1) return threads;
  const next = threads.slice();
  next[idx] = { ...next[idx], ...patch, updatedAt: Date.now() };
  return next;
}

function upsertAccount(accounts: Account[], account: Account): Account[] {
  const idx = accounts.findIndex((a) => a.id === account.id);
  if (idx === -1) return [...accounts, account];
  const next = accounts.slice();
  next[idx] = account;
  return next;
}

function upsertChatItem(items: ChatItem[], item: ChatItem): ChatItem[] {
  const idx = items.findIndex((i) => i.id === item.id);
  if (idx === -1) return [...items, item];
  const next = items.slice();
  next[idx] = item;
  return next;
}

const EMPTY_CHAT_ITEMS: ChatItem[] = [];

/** A draft never starts in bypassPermissions (main confirms it when the thread starts). */
function safeDraftMode(mode: UiPermissionMode): UiPermissionMode {
  return mode === 'bypassPermissions' ? 'default' : mode;
}

/** Prefix of notices synthesized from `error` ChatEvents (not persisted, so never in `chat:history`). */
const LOCAL_ERROR_PREFIX = 'local-error-';
let localErrorSeq = 0;

/** Persisted error notices supersede a locally synthesized one with the same text. */
function dropSupersededLocalErrors(items: ChatItem[], incoming: readonly ChatItem[]): ChatItem[] {
  const texts = new Set<string>();
  for (const i of incoming) {
    if (i.type === 'notice' && i.level === 'error' && !i.id.startsWith(LOCAL_ERROR_PREFIX)) texts.add(i.text);
  }
  if (texts.size === 0) return items;
  return items.filter((i) => !(i.type === 'notice' && i.id.startsWith(LOCAL_ERROR_PREFIX) && texts.has(i.text)));
}

/**
 * Merges a `chat:history` result into items already received live (L15): history order first, live
 * items with an id missing from history appended after it. For an id present in both, the live copy wins
 * (it may be newer than the log, e.g. a tool result that arrived after the read).
 */
export function mergeChatHistory(live: readonly ChatItem[], history: readonly ChatItem[]): ChatItem[] {
  if (live.length === 0) return history.slice();
  const liveById = new Map(live.map((i) => [i.id, i]));
  const historyIds = new Set(history.map((i) => i.id));
  const merged = history.map((i) => liveById.get(i.id) ?? i);
  for (const item of live) if (!historyIds.has(item.id)) merged.push(item);
  return dropSupersededLocalErrors(merged, history);
}

export interface AppStoreState {
  // bootstrap-derived
  bootstrapped: boolean;
  appVersion: string | null;
  projects: Project[];
  threads: Thread[];
  accounts: Account[];
  pool: PoolSnapshot;
  settings: AppSettings;
  models: ModelOption[];
  /** User home (bootstrap); paths are displayed with `~`. */
  homeDir: string | null;

  // UI / routing
  /** null (with route 'chat') shows the draft "new chat" screen. */
  selectedThreadId: string | null;
  route: Route;
  sidebarCollapsed: boolean;
  draft: DraftState;
  /** The open transcript is scrolled away from its top (the chat title bar shows its divider). */
  chatScrolled: boolean;
  /** Right panel tab, or null when closed. */
  panel: PanelTab | null;
  panelWidth: number;
  paletteOpen: boolean;
  modal: AppModal | null;
  /** Accounts route opened from "사용량": scroll to the usage charts once. */
  accountsFocus: 'usage' | null;
  /** Threads whose turn finished while another view was showing (sidebar "완료" pill until opened). */
  unseenDone: Record<string, true>;
  composerPrefill: ComposerPrefill | null;
  /** Bumped after a git action (commit, merge, revert) so the changes panel reloads. */
  gitRevision: Record<string, number>;
  /** Fixture / e2e run (bootstrap): no system notifications. */
  testMode: boolean;

  // per-thread chat state
  chatItemsByThread: Record<string, ChatItem[]>;
  streamingItemIdByThread: Record<string, string | null>;
  permissionRequests: PermissionRequest[];

  // account login pty + terminal pty (lightweight: raw byte stream stays component-local, see events.ts)
  loginSessions: Record<string, LoginSessionState>;
  ptyStatusByThread: Record<string, PtyStatus>;

  // -- actions (invoke wrappers) --
  bootstrap: () => Promise<void>;
  selectThread: (threadId: string | null) => void;
  setRoute: (route: Route) => void;
  toggleTerminal: () => void;
  setTerminalOpen: (open: boolean) => void;
  toggleSidebar: () => void;
  setChatScrolled: (scrolled: boolean) => void;
  /** Opens the tab, or closes the panel when that tab is already showing. */
  togglePanel: (tab: PanelTab) => void;
  setPanel: (tab: PanelTab | null) => void;
  setPanelWidth: (width: number) => void;
  setPaletteOpen: (open: boolean) => void;
  setModal: (modal: AppModal | null) => void;
  /** Accounts route, optionally scrolled to the usage charts. */
  openAccounts: (focus?: 'usage') => void;
  clearAccountsFocus: () => void;
  prefillComposer: (target: string, text: string, mode?: ComposerPrefill['mode']) => void;
  clearComposerPrefill: () => void;
  /** "New Task Start" (draft button / ⌘⇧N / palette): ensures an empty draft is showing, then prepends the
   * settings' template (placeholders filled) to whatever the composer already holds. */
  startNewTask: () => void;
  bumpGitRevision: (threadId: string) => void;
  updateSettings: (patch: SettingsPatch) => Promise<AppSettings>;
  deleteArchivedThreads: () => Promise<number>;
  /** Opens an empty draft (⌘N / "새 채팅") in the last used folder. */
  newDraft: () => void;
  setDraft: (patch: Partial<DraftState>) => void;
  /** Draft -> thread: `thread:start` with the draft settings; selects the thread when it was created. */
  startThread: (text: string) => Promise<ThreadStartResult>;
  setThreadPinned: (threadId: string, pinned: boolean) => Promise<void>;
  setThreadArchived: (threadId: string, archived: boolean) => Promise<void>;
  setThreadEffort: (threadId: string, effort: EffortLevel | null) => Promise<void>;
  /** Native file picker; resolves `@` mentions relative to the thread (or draft folder). */
  pickFiles: (target: { threadId?: string; projectId?: string }) => Promise<string[]>;

  addProject: () => Promise<Project | null>;
  removeProject: (projectId: string) => Promise<void>;
  setProjectTrusted: (projectId: string, trusted: boolean) => Promise<void>;
  createThread: (
    projectId: string,
    opts?: { title?: string; model?: string; permissionMode?: UiPermissionMode },
  ) => Promise<Thread>;
  renameThread: (threadId: string, title: string) => Promise<void>;
  /**
   * Deletes the thread and its worktree. Resolves `{ok:false, reason:'worktree-dirty'}` (nothing deleted) when the
   * worktree has uncommitted changes; `force` discards them.
   */
  deleteThread: (threadId: string, force?: boolean) => Promise<InvokeResponse<'thread:delete'>>;
  setThreadModel: (threadId: string, model: string) => Promise<void>;
  setThreadPermissionMode: (threadId: string, mode: UiPermissionMode) => Promise<void>;
  pinAccount: (threadId: string, accountId: string | null) => Promise<void>;

  loadChatHistory: (threadId: string) => Promise<void>;
  sendMessage: (threadId: string, text: string) => Promise<ChatSendResult>;
  interrupt: (threadId: string) => Promise<void>;
  respondPermission: (requestId: string, decision: PermissionDecision, message?: string) => Promise<void>;

  loadModels: () => Promise<void>;

  startLogin: (alias: string, color: string) => Promise<{ loginId: string; accountId: string }>;
  loginInput: (loginId: string, data: string) => Promise<void>;
  cancelLogin: (loginId: string) => Promise<void>;
  clearLoginSession: (loginId: string) => void;
  updateAccount: (accountId: string, patch: AccountPatch) => Promise<Account>;
  reorderAccounts: (orderedIds: string[]) => Promise<void>;
  removeAccount: (accountId: string) => Promise<void>;

  refreshUsage: (accountId?: string) => Promise<PoolSnapshot>;
  fetchUsageHistory: (accountId: string, rangeMs: number) => Promise<UsageSample[]>;

  /** `projectId` is only consulted for the draft session (`threadId: DRAFT_PTY_SESSION_ID`). */
  openTerminal: (
    threadId: string,
    cols: number,
    rows: number,
    projectId?: string,
  ) => Promise<{ ptyId: string; replay: string }>;
  writeTerminal: (threadId: string, data: string) => Promise<void>;
  resizeTerminal: (threadId: string, cols: number, rows: number) => Promise<void>;

  // -- event application (also called directly by store/events.ts subscribers) --
  applyBootstrap: (payload: BootstrapPayload) => void;
  applyThreadUpdated: (thread: Thread) => void;
  applyChatEvent: (threadId: string, event: ChatEvent) => void;
  applyPermissionRequest: (req: PermissionRequest) => void;
  applyPermissionCancel: (requestId: string) => void;
  applyUsageUpdated: (pool: PoolSnapshot) => void;
  applyAccountsUpdated: (accounts: Account[]) => void;
  applyLoginData: (loginId: string, data: string) => void;
  applyLoginExit: (loginId: string, ok: boolean, account?: Account, error?: string) => void;
  applyPtyExit: (threadId: string, code: number) => void;
  applySettingsUpdated: (settings: AppSettings) => void;
  applyModelsUpdated: (models: ModelOption[]) => void;
}

export const useAppStore = create<AppStoreState>()((set, get) => ({
  bootstrapped: false,
  appVersion: null,
  projects: [],
  threads: [],
  accounts: [],
  pool: EMPTY_POOL,
  settings: EMPTY_SETTINGS,
  models: [],
  homeDir: null,

  selectedThreadId: null,
  route: 'chat',
  sidebarCollapsed: readSidebarCollapsed(),
  chatScrolled: false,
  panel: null,
  panelWidth: readPanelWidth(),
  paletteOpen: false,
  modal: null,
  accountsFocus: null,
  unseenDone: {},
  composerPrefill: null,
  gitRevision: {},
  testMode: false,
  draft: {
    projectId: null,
    agent: DEFAULT_AGENT,
    model: EMPTY_SETTINGS.defaultModel,
    permissionMode: EMPTY_SETTINGS.defaultPermissionMode,
    effort: null,
    pinnedAccountId: null,
  },

  chatItemsByThread: {},
  streamingItemIdByThread: {},
  permissionRequests: [],

  loginSessions: {},
  ptyStatusByThread: {},

  bootstrap: async () => {
    const payload = await invoke('app:bootstrap');
    get().applyBootstrap(payload);
  },

  selectThread: (threadId) =>
    set((s) => {
      if (!threadId || !s.unseenDone[threadId]) return { selectedThreadId: threadId };
      const unseenDone = { ...s.unseenDone };
      delete unseenDone[threadId];
      return { selectedThreadId: threadId, unseenDone };
    }),
  setRoute: (route) => set({ route }),
  toggleTerminal: () => get().togglePanel('terminal'),
  setTerminalOpen: (open) => set((s) => ({ panel: open ? 'terminal' : s.panel === 'terminal' ? null : s.panel })),
  togglePanel: (tab) => set((s) => ({ panel: s.panel === tab ? null : tab })),
  setPanel: (tab) => set({ panel: tab }),
  setPanelWidth: (width) => {
    const next = clampPanelWidth(width);
    writePanelWidth(next);
    set({ panelWidth: next });
  },
  setPaletteOpen: (open) => set({ paletteOpen: open }),
  setModal: (modal) => set({ modal, paletteOpen: false }),
  openAccounts: (focus) => set({ route: 'accounts', accountsFocus: focus ?? null }),
  clearAccountsFocus: () => set({ accountsFocus: null }),
  prefillComposer: (target, text, mode = 'replace') =>
    set((s) => ({ composerPrefill: { target, text, mode, nonce: (s.composerPrefill?.nonce ?? 0) + 1 } })),
  clearComposerPrefill: () => set({ composerPrefill: null }),
  startNewTask: () => {
    const s = get();
    // Already an empty draft: keep it (its folder, model, etc.) and just prepend the template. Otherwise this
    // behaves like ⌘N first, so the template lands in a fresh draft.
    if (!(s.route === 'chat' && s.selectedThreadId === null)) s.newDraft();
    const { draft, projects, settings } = get();
    const projectName = draft.projectId ? (projects.find((p) => p.id === draft.projectId)?.name ?? null) : null;
    const filled = fillNewTaskTemplate(settings.newTaskTemplate, projectName);
    get().prefillComposer('draft', filled, 'prepend');
  },
  bumpGitRevision: (threadId) => set((s) => ({ gitRevision: { ...s.gitRevision, [threadId]: (s.gitRevision[threadId] ?? 0) + 1 } })),
  updateSettings: async (patch) => {
    const settings = await invoke('settings:update', patch);
    get().applySettingsUpdated(settings);
    return settings;
  },
  deleteArchivedThreads: async () => {
    const { deleted } = await invoke('threads:deleteArchived');
    set((s) => {
      const gone = new Set(s.threads.filter((t) => t.archived).map((t) => t.id));
      const chatItemsByThread = { ...s.chatItemsByThread };
      for (const id of gone) delete chatItemsByThread[id];
      return {
        threads: s.threads.filter((t) => !gone.has(t.id)),
        chatItemsByThread,
        selectedThreadId: s.selectedThreadId && gone.has(s.selectedThreadId) ? null : s.selectedThreadId,
      };
    });
    return deleted;
  },
  toggleSidebar: () =>
    set((s) => {
      writeSidebarCollapsed(!s.sidebarCollapsed);
      return { sidebarCollapsed: !s.sidebarCollapsed };
    }),

  setChatScrolled: (scrolled) => {
    if (get().chatScrolled !== scrolled) set({ chatScrolled: scrolled });
  },

  newDraft: () =>
    set((s) => ({
      selectedThreadId: null,
      route: 'chat',
      // A new chat starts from the settings' defaults (설정 > 일반), in the last used folder.
      draft: {
        ...s.draft,
        projectId: defaultDraftProjectId(s.projects, s.threads),
        agent: DEFAULT_AGENT,
        model: s.settings.defaultModel,
        permissionMode: safeDraftMode(s.settings.defaultPermissionMode),
        effort: s.settings.defaultEffort ?? null,
        pinnedAccountId: null,
      },
    })),

  setDraft: (patch) => set((s) => ({ draft: { ...s.draft, ...patch } })),

  startThread: async (text) => {
    const { draft } = get();
    if (!draft.projectId) throw new Error('No folder selected for the new chat');
    const result = await invoke('thread:start', {
      projectId: draft.projectId,
      agent: draft.agent,
      text,
      model: draft.model,
      permissionMode: draft.permissionMode,
      effort: draft.effort,
      pinnedAccountId: draft.pinnedAccountId,
    });
    if (result.ok) {
      get().applyThreadUpdated(result.thread);
      set({ selectedThreadId: result.thread.id, route: 'chat' });
    }
    return result;
  },

  setThreadPinned: async (threadId, pinned) => {
    await invoke('thread:setPinned', { threadId, pinned });
    set((s) => ({ threads: patchThreadLocal(s.threads, threadId, { pinned }) }));
  },

  setThreadArchived: async (threadId, archived) => {
    await invoke('thread:setArchived', { threadId, archived });
    set((s) => ({
      threads: patchThreadLocal(s.threads, threadId, archived ? { archived, pinned: false } : { archived }),
    }));
  },

  // Applied value arrives via `thread:updated`; the local patch keeps the picker responsive meanwhile.
  setThreadEffort: async (threadId, effort) => {
    await invoke('thread:setEffort', { threadId, effort });
    set((s) => ({ threads: patchThreadLocal(s.threads, threadId, { effort }) }));
  },

  pickFiles: async (target) => invoke('dialog:pickFiles', target),

  addProject: async () => {
    const project = await invoke('project:add');
    if (project) set((s) => ({ projects: s.projects.some((p) => p.id === project.id) ? s.projects : [...s.projects, project] }));
    return project;
  },

  removeProject: async (projectId) => {
    await invoke('project:remove', { projectId });
    set((s) => {
      const removedIds = new Set(s.threads.filter((t) => t.projectId === projectId).map((t) => t.id));
      const chatItemsByThread = { ...s.chatItemsByThread };
      const streamingItemIdByThread = { ...s.streamingItemIdByThread };
      for (const id of removedIds) {
        delete chatItemsByThread[id];
        delete streamingItemIdByThread[id];
      }
      return {
        projects: s.projects.filter((p) => p.id !== projectId),
        threads: s.threads.filter((t) => t.projectId !== projectId),
        chatItemsByThread,
        streamingItemIdByThread,
        permissionRequests: s.permissionRequests.filter((r) => !removedIds.has(r.threadId)),
        selectedThreadId: s.selectedThreadId && removedIds.has(s.selectedThreadId) ? null : s.selectedThreadId,
        draft:
          s.draft.projectId === projectId
            ? {
                ...s.draft,
                projectId: defaultDraftProjectId(
                  s.projects.filter((p) => p.id !== projectId),
                  s.threads.filter((t) => t.projectId !== projectId),
                ),
              }
            : s.draft,
      };
    });
  },

  // Trusting shows a native confirm in main; the returned project carries the value actually applied.
  setProjectTrusted: async (projectId, trusted) => {
    const project = await invoke('project:setTrusted', { projectId, trusted });
    set((s) => ({ projects: s.projects.map((p) => (p.id === project.id ? project : p)) }));
  },

  createThread: async (projectId, opts) => {
    const thread = await invoke('thread:create', { projectId, ...opts });
    get().applyThreadUpdated(thread);
    set({ selectedThreadId: thread.id, route: 'chat' });
    return thread;
  },

  renameThread: async (threadId, title) => {
    await invoke('thread:rename', { threadId, title });
    set((s) => ({ threads: patchThreadLocal(s.threads, threadId, { title }) }));
  },

  deleteThread: async (threadId, force = false) => {
    const result = await invoke('thread:delete', { threadId, removeWorktree: true, ...(force ? { force } : {}) });
    if (!result.ok) return result;
    set((s) => {
      const chatItemsByThread = { ...s.chatItemsByThread };
      delete chatItemsByThread[threadId];
      const streamingItemIdByThread = { ...s.streamingItemIdByThread };
      delete streamingItemIdByThread[threadId];
      return {
        threads: s.threads.filter((t) => t.id !== threadId),
        chatItemsByThread,
        streamingItemIdByThread,
        permissionRequests: s.permissionRequests.filter((r) => r.threadId !== threadId),
        selectedThreadId: s.selectedThreadId === threadId ? null : s.selectedThreadId,
      };
    });
    return result;
  },

  setThreadModel: async (threadId, model) => {
    await invoke('thread:setModel', { threadId, model });
    set((s) => ({ threads: patchThreadLocal(s.threads, threadId, { model }) }));
  },

  // No optimistic patch: main may ask for confirmation (bypassPermissions) and reports the result via
  // `thread:updated`.
  setThreadPermissionMode: async (threadId, mode) => {
    await invoke('thread:setPermissionMode', { threadId, mode });
  },

  pinAccount: async (threadId, accountId) => {
    await invoke('thread:pinAccount', { threadId, accountId });
    set((s) => ({ threads: patchThreadLocal(s.threads, threadId, { pinnedAccountId: accountId }) }));
  },

  loadChatHistory: async (threadId) => {
    const history = await invoke('chat:history', { threadId });
    set((s) => ({
      chatItemsByThread: {
        ...s.chatItemsByThread,
        [threadId]: mergeChatHistory(s.chatItemsByThread[threadId] ?? EMPTY_CHAT_ITEMS, history),
      },
    }));
  },

  sendMessage: async (threadId, text) => invoke('chat:send', { threadId, text }),

  interrupt: async (threadId) => {
    await invoke('chat:interrupt', { threadId });
  },

  respondPermission: async (requestId, decision, message) => {
    await invoke('permission:respond', { requestId, decision, message });
    set((s) => ({ permissionRequests: s.permissionRequests.filter((r) => r.requestId !== requestId) }));
  },

  loadModels: async () => {
    const models = await invoke('models:list');
    set({ models });
  },

  startLogin: async (alias, color) => {
    const result = await invoke('account:loginStart', { alias, color });
    set((s) => ({
      loginSessions: {
        ...s.loginSessions,
        [result.loginId]: { output: '', done: false, ok: null, account: null, error: null },
      },
    }));
    return result;
  },

  loginInput: async (loginId, data) => {
    await invoke('account:loginInput', { loginId, data });
  },

  cancelLogin: async (loginId) => {
    await invoke('account:loginCancel', { loginId });
  },

  clearLoginSession: (loginId) =>
    set((s) => {
      const loginSessions = { ...s.loginSessions };
      delete loginSessions[loginId];
      return { loginSessions };
    }),

  updateAccount: async (accountId, patch) => {
    const account = await invoke('account:update', { accountId, patch });
    set((s) => ({ accounts: upsertAccount(s.accounts, account) }));
    return account;
  },

  reorderAccounts: async (orderedIds) => {
    await invoke('account:reorder', { orderedIds });
    set((s) => {
      const byId = new Map(s.accounts.map((a) => [a.id, a]));
      const reordered = orderedIds.map((id) => byId.get(id)).filter((a): a is Account => !!a);
      const remaining = s.accounts.filter((a) => !orderedIds.includes(a.id));
      // Priority mirrors list order (lower = preferred) so priority-sorted views update before `account:updated`.
      return { accounts: [...reordered, ...remaining].map((a, priority) => (a.priority === priority ? a : { ...a, priority })) };
    });
  },

  removeAccount: async (accountId) => {
    const result = await invoke('account:remove', { accountId, deleteConfigDir: true });
    if (!result.ok) throw new Error(result.error);
    set((s) => ({ accounts: s.accounts.filter((a) => a.id !== accountId) }));
  },

  refreshUsage: async (accountId) => {
    const pool = await invoke('usage:refresh', { accountId });
    set({ pool });
    return pool;
  },

  fetchUsageHistory: async (accountId, rangeMs) => invoke('usage:history', { accountId, rangeMs }),

  openTerminal: async (threadId, cols, rows, projectId) => {
    const result = await invoke('pty:open', { threadId, cols, rows, ...(projectId ? { projectId } : {}) });
    set((s) => ({
      ptyStatusByThread: {
        ...s.ptyStatusByThread,
        [threadId]: { ptyId: result.ptyId, running: true, lastExitCode: null },
      },
    }));
    return result;
  },

  writeTerminal: async (threadId, data) => {
    await invoke('pty:write', { threadId, data });
  },

  resizeTerminal: async (threadId, cols, rows) => {
    await invoke('pty:resize', { threadId, cols, rows });
  },

  applyBootstrap: (payload) =>
    set((s) => ({
      bootstrapped: true,
      projects: payload.projects,
      threads: payload.threads,
      accounts: payload.accounts,
      pool: payload.pool,
      settings: payload.settings,
      appVersion: payload.appVersion,
      homeDir: payload.homeDir ?? null,
      // Permission prompts still waiting in main survive a renderer reload (M7).
      permissionRequests: payload.pendingPermissions ?? [],
      testMode: payload.testMode === true,
      // Launch opens a new chat (draft) in the last used folder; an explicit selection is kept on re-bootstrap.
      selectedThreadId:
        s.selectedThreadId && payload.threads.some((t) => t.id === s.selectedThreadId) ? s.selectedThreadId : null,
      draft: {
        ...s.draft,
        projectId:
          s.draft.projectId && payload.projects.some((p) => p.id === s.draft.projectId)
            ? s.draft.projectId
            : defaultDraftProjectId(payload.projects, payload.threads),
        ...(s.bootstrapped
          ? {}
          : {
              model: payload.settings.defaultModel,
              permissionMode: safeDraftMode(payload.settings.defaultPermissionMode),
              effort: payload.settings.defaultEffort ?? null,
            }),
      },
    })),

  applyThreadUpdated: (thread) => set((s) => ({ threads: upsertThread(s.threads, thread) })),

  applyChatEvent: (threadId, event) => {
    switch (event.type) {
      case 'text-delta':
        // Accumulate into a provisional assistant-text item; the final item-upsert (same id) replaces it.
        set((s) => {
          const items = s.chatItemsByThread[threadId] ?? EMPTY_CHAT_ITEMS;
          const existing = items.find((i) => i.id === event.itemId);
          const item: ChatItem =
            existing?.type === 'assistant-text'
              ? { ...existing, text: existing.text + event.text }
              : { type: 'assistant-text', id: event.itemId, text: event.text, createdAt: Date.now() };
          return {
            chatItemsByThread: { ...s.chatItemsByThread, [threadId]: upsertChatItem(items, item) },
            streamingItemIdByThread: { ...s.streamingItemIdByThread, [threadId]: event.itemId },
          };
        });
        break;
      case 'item-upsert':
        set((s) => ({
          chatItemsByThread: {
            ...s.chatItemsByThread,
            [threadId]: upsertChatItem(
              dropSupersededLocalErrors(s.chatItemsByThread[threadId] ?? EMPTY_CHAT_ITEMS, [event.item]),
              event.item,
            ),
          },
          streamingItemIdByThread:
            s.streamingItemIdByThread[threadId] === event.item.id
              ? { ...s.streamingItemIdByThread, [threadId]: null }
              : s.streamingItemIdByThread,
        }));
        break;
      case 'turn-start':
        set((s) => ({ streamingItemIdByThread: { ...s.streamingItemIdByThread, [threadId]: null } }));
        break;
      case 'turn-end':
        set((s) => {
          // A finished turn the user is not looking at gets the sidebar "완료" pill until the thread is opened.
          const watching = s.route === 'chat' && s.selectedThreadId === threadId;
          const done = event.ok && !watching;
          return {
            streamingItemIdByThread: { ...s.streamingItemIdByThread, [threadId]: null },
            ...(done ? { unseenDone: { ...s.unseenDone, [threadId]: true as const } } : {}),
          };
        });
        break;
      case 'error':
        // Shown as an error notice. If main also logs it as a notice item, that item supersedes this one
        // (item-upsert / history merge drop same-text local errors), and a recent identical notice is not repeated.
        set((s) => {
          const items = s.chatItemsByThread[threadId] ?? EMPTY_CHAT_ITEMS;
          const recent = items.slice(-3);
          if (recent.some((i) => i.type === 'notice' && i.level === 'error' && i.text === event.message)) return {};
          const notice: ChatItem = {
            type: 'notice',
            id: `${LOCAL_ERROR_PREFIX}${++localErrorSeq}`,
            level: 'error',
            text: event.message,
            createdAt: Date.now(),
          };
          return {
            chatItemsByThread: { ...s.chatItemsByThread, [threadId]: [...items, notice] },
            streamingItemIdByThread: { ...s.streamingItemIdByThread, [threadId]: null },
          };
        });
        break;
      default:
        break;
    }
  },

  applyPermissionRequest: (req) =>
    set((s) => ({
      permissionRequests: [...s.permissionRequests.filter((r) => r.requestId !== req.requestId), req],
    })),

  applyPermissionCancel: (requestId) =>
    set((s) => ({ permissionRequests: s.permissionRequests.filter((r) => r.requestId !== requestId) })),

  applyUsageUpdated: (pool) => set({ pool }),

  applyAccountsUpdated: (accounts) => set({ accounts }),

  applyLoginData: (loginId, data) =>
    set((s) => ({
      loginSessions: {
        ...s.loginSessions,
        [loginId]: {
          output: (s.loginSessions[loginId]?.output ?? '') + data,
          done: false,
          ok: null,
          account: null,
          error: null,
        },
      },
    })),

  applyLoginExit: (loginId, ok, account, error) =>
    set((s) => ({
      loginSessions: {
        ...s.loginSessions,
        [loginId]: {
          output: s.loginSessions[loginId]?.output ?? '',
          done: true,
          ok,
          account: account ?? null,
          error: error ?? null,
        },
      },
      accounts: account ? upsertAccount(s.accounts, account) : s.accounts,
    })),

  applySettingsUpdated: (settings) => set({ settings }),

  applyModelsUpdated: (models) => set({ models }),

  applyPtyExit: (threadId, code) =>
    set((s) => ({
      ptyStatusByThread: { ...s.ptyStatusByThread, [threadId]: { ptyId: null, running: false, lastExitCode: code } },
    })),
}));
