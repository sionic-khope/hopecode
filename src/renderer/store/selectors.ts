// Pure selector functions over `AppStoreState` (plan 4.4 store selectors). Plain functions rather
// than hooks so they're usable both as `useAppStore(selectX)` and directly in tests.
import { summarizePool } from '../../core/poolSummary';
import type { Account, ChatItem, PermissionRequest, PoolSnapshot, PoolSummary, Project, Thread } from '../../shared/types';
import type { AppStoreState, LoginSessionState, PtyStatus, Route } from './appStore';

const EMPTY_CHAT_ITEMS: ChatItem[] = [];
const EMPTY_PERMISSIONS: PermissionRequest[] = [];

export const selectProjects = (s: AppStoreState): Project[] => s.projects;
export const selectThreads = (s: AppStoreState): Thread[] => s.threads;
export const selectAccounts = (s: AppStoreState): Account[] => s.accounts;
export const selectRoute = (s: AppStoreState): Route => s.route;
export const selectTerminalOpen = (s: AppStoreState): boolean => s.terminalOpen;
export const selectTerminalHeight = (s: AppStoreState): number => s.terminalHeight;
export const selectPanel = (s: AppStoreState) => s.panel;
export const selectPanelWidth = (s: AppStoreState): number => s.panelWidth;
export const selectSelectedThreadId = (s: AppStoreState): string | null => s.selectedThreadId;
export const selectBootstrapped = (s: AppStoreState): boolean => s.bootstrapped;

export const selectSelectedThread = (s: AppStoreState): Thread | null =>
  s.threads.find((t) => t.id === s.selectedThreadId) ?? null;

export const selectThreadById = (s: AppStoreState, threadId: string): Thread | undefined =>
  s.threads.find((t) => t.id === threadId);

export const selectThreadsByProject = (s: AppStoreState, projectId: string): Thread[] =>
  s.threads.filter((t) => t.projectId === projectId);

export const selectChatItems = (s: AppStoreState, threadId: string): ChatItem[] =>
  s.chatItemsByThread[threadId] ?? EMPTY_CHAT_ITEMS;

export const selectStreamingItemId = (s: AppStoreState, threadId: string): string | null =>
  s.streamingItemIdByThread[threadId] ?? null;

/** All pending permission requests, or only the ones for `threadId` when given. */
export const selectPendingPermissions = (s: AppStoreState, threadId?: string): PermissionRequest[] =>
  threadId ? s.permissionRequests.filter((r) => r.threadId === threadId) : (s.permissionRequests.length ? s.permissionRequests : EMPTY_PERMISSIONS);

export const selectAccountById = (s: AppStoreState, accountId: string | null | undefined): Account | undefined =>
  accountId ? s.accounts.find((a) => a.id === accountId) : undefined;

export const selectPoolSnapshot = (s: AppStoreState): PoolSnapshot => s.pool;

/**
 * Recomputes with `core/poolSummary` against a caller-supplied `now` so meters and reset
 * countdowns stay accurate between `usage:updated` broadcasts (main only pushes on change /
 * ~90s poll). Pass a locally-ticking `now`; defaults to `Date.now()`.
 */
export const selectPoolSummary = (s: AppStoreState, now: number = Date.now()): PoolSummary =>
  summarizePool(s.accounts, s.pool.usageById, now);

export const selectModels = (s: AppStoreState) => s.models;
export const selectSettings = (s: AppStoreState) => s.settings;
export const selectAppVersion = (s: AppStoreState): string | null => s.appVersion;

export const selectLoginSession = (s: AppStoreState, loginId: string): LoginSessionState | undefined =>
  s.loginSessions[loginId];

export const selectPtyStatus = (s: AppStoreState, threadId: string): PtyStatus | undefined =>
  s.ptyStatusByThread[threadId];

export const selectSidebarCollapsed = (s: AppStoreState): boolean => s.sidebarCollapsed;
export const selectDraft = (s: AppStoreState) => s.draft;
export const selectHomeDir = (s: AppStoreState): string | null => s.homeDir;
export const selectChatScrolled = (s: AppStoreState): boolean => s.chatScrolled;
