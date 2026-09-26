import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { concreteModelLabel, defaultModelLabelFrom } from '../core/modelDisplay';
import './App.css';
import { invoke, on } from './api';
import { AccountsPage } from './components/Accounts/AccountsPage';
import { AddAccountDialog, type LoginStatus } from './components/Accounts/AddAccountDialog';
import { ChatView, DraftView } from './components/Chat';
import { BoltIcon } from './components/Chat/icons';
import { CommandPalette, type PaletteCommand } from './components/Palette/CommandPalette';
import { SettingsPage } from './components/Settings/SettingsPage';
import { PluginsPage } from './components/Nav/PluginsPage';
import { PullRequestsPage } from './components/Nav/PullRequestsPage';
import { SchedulePage } from './components/Nav/SchedulePage';
import type { NavPage } from './components/Sidebar/SidebarNav';
import type { PullRequestInfo } from '../shared/nav';
import { AboutModal, ShortcutsModal } from './components/Shell/AppModals';
import { ChatHeader } from './components/Shell/ChatHeader';
import { WindowToolbar } from './components/Shell/WindowToolbar';
import { RightPanel, forgetTerminalSize } from './components/Shell/RightPanel';
import { NEEDS_FORCE } from './components/Sidebar/ItemMenu';
import { ProfileRow } from './components/Sidebar/ProfileRow';
import { Sidebar } from './components/Sidebar/Sidebar';
import { IconClock, IconCompose, IconPlug, IconPullRequest, IconSidebar } from './components/Sidebar/icons';
import { StatusLine } from './components/StatusLine/StatusLine';
import {
  GlyphChanges,
  GlyphChart,
  GlyphCode,
  GlyphInfo,
  GlyphKeyboard,
  GlyphPeople,
  GlyphSettings,
  GlyphTerminal,
} from './components/common/glyphs';
import { disposeTerminalEntry, resetTerminalEntry } from './components/Terminal/terminalRegistry';
import { ipcErrorMessage } from './errors';
import { useNotifications } from './hooks/useNotifications';
import {
  initStoreEventSubscriptions,
  selectAccounts,
  selectChatScrolled,
  selectDraft,
  selectHomeDir,
  selectModels,
  selectPanel,
  selectPanelWidth,
  selectPoolSnapshot,
  selectProjects,
  selectRoute,
  selectSelectedThread,
  selectSelectedThreadId,
  selectSettings,
  selectSidebarCollapsed,
  selectThreads,
  useAppStore,
  type PanelTab,
} from './store';
import { ACCOUNT_COLORS, DAY_MS, DRAFT_PTY_SESSION_ID, MINUTE_MS } from '../shared/constants';
import type {
  ChatImage,
  ChatSendResult,
  EditorId,
  EditorInfo,
  EffortLevel,
  PermissionDecision,
  UiPermissionMode,
  UsageSample,
} from '../shared/types';

const USAGE_HISTORY_RANGE_MS = 7 * DAY_MS;
const USAGE_HISTORY_REFRESH_MS = 5 * MINUTE_MS;
/** Last `usage:history` result per account (renderer session). */
const usageHistoryCache = new Map<string, { at: number; samples: UsageSample[] }>();

function cachedUsageHistory(): Record<string, UsageSample[]> {
  return Object.fromEntries([...usageHistoryCache].map(([id, entry]) => [id, entry.samples]));
}
/** Threads whose `chat:history` was requested in this renderer session. */
const historyRequested = new Set<string>();

function sendErrorMessage(result: ChatSendResult | { accepted: false; reason?: ChatSendResult['reason'] }): string | null {
  if (result.accepted) return null;
  switch (result.reason) {
    case 'busy':
      return '이 스레드가 아직 실행 중입니다. 턴이 끝나기를 기다리거나 정지를 누르세요.';
    case 'no-accounts':
      return '사용할 수 있는 계정이 없습니다. 계정 화면에서 계정을 추가하거나 활성화하세요.';
    case 'auth':
      return '모든 계정에 다시 로그인해야 합니다. 계정 화면에서 다시 로그인하세요.';
    default:
      return '메시지를 보내지 못했습니다.';
  }
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

const reportError = (label: string) => (err: unknown) => console.error(`[hopecode] ${label}`, err);

const loadAppInfo = () => invoke('app:info');
const loadDataDir = () => invoke('app:info').then((i) => i.dataDir);
const loadSharedStatus = () => invoke('config:sharedStatus');
const relinkShared = () => invoke('config:relink');
const openDataFolder = () => invoke('app:openDataFolder');
const loadEditorList = () => invoke('editor:list');

/**
 * Shell: a pale canvas carrying floating cards: sidebar (⌘B) with the profile footer | conversation, draft,
 * accounts or settings | right panel (변경사항 / 터미널, ⌘⇧D / ⌘J); a thin statusline underneath.
 */
export function App() {
  const projects = useAppStore(selectProjects);
  const threads = useAppStore(selectThreads);
  const accounts = useAppStore(selectAccounts);
  const pool = useAppStore(selectPoolSnapshot);
  const models = useAppStore(selectModels);
  const route = useAppStore(selectRoute);
  const panel = useAppStore(selectPanel);
  const panelWidth = useAppStore(selectPanelWidth);
  const sidebarCollapsed = useAppStore(selectSidebarCollapsed);
  const selectedThreadId = useAppStore(selectSelectedThreadId);
  const activeThread = useAppStore(selectSelectedThread);
  const draft = useAppStore(selectDraft);
  const homeDir = useAppStore(selectHomeDir);
  const chatScrolled = useAppStore(selectChatScrolled);
  const settings = useAppStore(selectSettings);
  const unseenDone = useAppStore((s) => s.unseenDone);
  const paletteOpen = useAppStore((s) => s.paletteOpen);
  const modal = useAppStore((s) => s.modal);
  const defaultModelLabel = useMemo(() => defaultModelLabelFrom(threads, models), [threads, models]);

  const [sendError, setSendError] = useState<string | null>(null);
  const [editors, setEditors] = useState<EditorInfo[]>([]);
  const [resizing, setResizing] = useState(false);
  const [addAccountRequest, setAddAccountRequest] = useState(0);
  const [firstMessages, setFirstMessages] = useState<Record<string, string>>({});

  useNotifications();

  // Store <-> main wiring, once per mount. ⌘N / ⌘B / ⌘J / ⌘K / ⌘, come only from the app menu (`ui:*` events in
  // store/events.ts), so each shortcut runs exactly once.
  useEffect(() => {
    const off = initStoreEventSubscriptions();
    const offPtyExit = on('pty:exit', ({ threadId }) => resetTerminalEntry(threadId));
    void useAppStore
      .getState()
      .bootstrap()
      .then(() => useAppStore.getState().loadModels())
      .catch(reportError('bootstrap failed'));
    return () => {
      off();
      offPtyExit();
    };
  }, []);

  // A file dropped on the window must not navigate it away from the app.
  useEffect(() => {
    const block = (e: DragEvent) => e.preventDefault();
    document.addEventListener('dragover', block);
    document.addEventListener('drop', block);
    return () => {
      document.removeEventListener('dragover', block);
      document.removeEventListener('drop', block);
    };
  }, []);

  // Load the persisted transcript the first time a thread is shown.
  useEffect(() => {
    if (!selectedThreadId || historyRequested.has(selectedThreadId)) return;
    historyRequested.add(selectedThreadId);
    void useAppStore
      .getState()
      .loadChatHistory(selectedThreadId)
      .catch((err: unknown) => {
        historyRequested.delete(selectedThreadId);
        console.error(err);
      });
  }, [selectedThreadId]);

  useEffect(() => setSendError(null), [selectedThreadId, route]);

  const onSelectThread = useCallback((threadId: string) => {
    const s = useAppStore.getState();
    s.selectThread(threadId);
    s.setRoute('chat');
  }, []);

  const onSend = useCallback((threadId: string, text: string, images?: ChatImage[]) => {
    setSendError(null);
    void useAppStore
      .getState()
      .sendMessage(threadId, text, images)
      // `{accepted:true, reason:'waiting'}`: queued behind the pool reset; the thread shows its countdown.
      .then((result) => setSendError(sendErrorMessage(result)))
      .catch((err: unknown) => setSendError(`메시지를 보내지 못했습니다: ${ipcErrorMessage(err)}`));
  }, []);

  const onStartThread = useCallback(async (text: string) => {
    setSendError(null);
    try {
      const result = await useAppStore.getState().startThread(text);
      if (result.ok) {
        // The thread exists and its history starts with this message (already streamed as chat:event).
        historyRequested.add(result.thread.id);
        setSendError(sendErrorMessage(result.send));
        return true;
      }
      setSendError(sendErrorMessage({ accepted: false, reason: result.reason }));
      return false;
    } catch (err) {
      setSendError(`채팅을 시작하지 못했습니다: ${ipcErrorMessage(err)}`);
      return false;
    }
  }, []);

  const onNewChat = useCallback(() => useAppStore.getState().newDraft(), []);
  const onNewChatIn = useCallback((projectId: string) => {
    const s = useAppStore.getState();
    s.newDraft();
    s.setDraft({ projectId });
  }, []);

  const onPickFolder = useCallback(() => useAppStore.getState().addProject(), []);
  const onAddProject = useCallback(() => {
    void useAppStore.getState().addProject().catch(reportError('add project failed'));
  }, []);
  const onDraftChange = useCallback((patch: Parameters<ReturnType<typeof useAppStore.getState>['setDraft']>[0]) => {
    useAppStore.getState().setDraft(patch);
  }, []);

  const onOpenAccounts = useCallback(() => useAppStore.getState().openAccounts(), []);
  const onOpenUsage = useCallback(() => useAppStore.getState().openAccounts('usage'), []);
  const onOpenSettings = useCallback(() => useAppStore.getState().setRoute('settings'), []);
  const onOpenSearch = useCallback(() => useAppStore.getState().setPaletteOpen(true), []);
  const onOpenPrs = useCallback(() => useAppStore.getState().setRoute('prs'), []);
  const onOpenSchedule = useCallback(() => useAppStore.getState().setRoute('schedule'), []);
  const onOpenPlugins = useCallback(() => useAppStore.getState().setRoute('plugins'), []);
  const onBackToChat = useCallback(() => useAppStore.getState().setRoute('chat'), []);
  // "이 PR로 새 채팅": a draft in the PR's project whose worktree starts from the PR branch.
  const onNewChatFromPr = useCallback((projectId: string, pr: PullRequestInfo) => {
    const s = useAppStore.getState();
    s.newDraft();
    s.setDraft({ projectId, base: { branch: pr.branch, pr: pr.number, title: pr.title } });
  }, []);
  const onToggleSidebar = useCallback(() => useAppStore.getState().toggleSidebar(), []);
  const onShowShortcuts = useCallback(() => useAppStore.getState().setModal('shortcuts'), []);
  const onShowAbout = useCallback(() => useAppStore.getState().setModal('about'), []);
  const onCloseModal = useCallback(() => useAppStore.getState().setModal(null), []);
  const onQuit = useCallback(() => void invoke('app:quit').catch(reportError('quit failed')), []);
  const onOpenDataFolder = useCallback(() => void openDataFolder().catch(reportError('open data folder failed')), []);
  const onAddAccount = useCallback(() => {
    useAppStore.getState().openAccounts();
    setAddAccountRequest((n) => n + 1);
  }, []);
  const onTogglePanel = useCallback((tab: PanelTab) => useAppStore.getState().togglePanel(tab), []);
  const onSelectTab = useCallback((tab: PanelTab) => useAppStore.getState().setPanel(tab), []);
  const onClosePanel = useCallback(() => useAppStore.getState().setPanel(null), []);
  const onResizePanel = useCallback((width: number) => useAppStore.getState().setPanelWidth(width), []);

  const onLoadEditors = useCallback(() => {
    void loadEditorList()
      .then(setEditors)
      .catch(reportError('editor list failed'));
  }, []);
  const onOpenEditor = useCallback((editor: EditorId) => {
    const threadId = useAppStore.getState().selectedThreadId;
    if (!threadId) return;
    void invoke('editor:open', { threadId, editor }).catch((err: unknown) => setSendError(`앱에서 열지 못했습니다: ${ipcErrorMessage(err)}`));
  }, []);

  const onRenameThread = useCallback((threadId: string, title: string) => useAppStore.getState().renameThread(threadId, title), []);
  const onRenameActive = useCallback(
    (title: string) => (activeThread ? useAppStore.getState().renameThread(activeThread.id, title) : Promise.resolve()),
    [activeThread],
  );
  const onSetPinned = useCallback((threadId: string, pinned: boolean) => {
    void useAppStore.getState().setThreadPinned(threadId, pinned).catch(reportError('pin failed'));
  }, []);
  const onSetArchived = useCallback((threadId: string, archived: boolean) => {
    const s = useAppStore.getState();
    void s.setThreadArchived(threadId, archived).catch(reportError('archive failed'));
    // Archiving the open thread leaves it: the view returns to a new chat.
    if (archived && s.selectedThreadId === threadId && s.route === 'chat') s.newDraft();
  }, []);

  const onDeleteThread = useCallback(async (threadId: string, force: boolean) => {
    const result = await useAppStore.getState().deleteThread(threadId, force);
    if (!result.ok) return NEEDS_FORCE;
    forgetThread(threadId);
  }, []);

  const onRemoveProject = useCallback(async (projectId: string) => {
    const threadIds = useAppStore
      .getState()
      .threads.filter((t) => t.projectId === projectId)
      .map((t) => t.id);
    await useAppStore.getState().removeProject(projectId);
    for (const id of threadIds) forgetThread(id);
  }, []);

  const onSetProjectTrusted = useCallback((projectId: string, trusted: boolean) => {
    void useAppStore.getState().setProjectTrusted(projectId, trusted).catch(reportError('trust change failed'));
  }, []);

  const onInterrupt = useCallback((threadId: string) => void useAppStore.getState().interrupt(threadId), []);
  const onPermissionDecision = useCallback(
    (requestId: string, decision: PermissionDecision) => void useAppStore.getState().respondPermission(requestId, decision),
    [],
  );
  const onModelChange = useCallback((threadId: string, model: string) => {
    void useAppStore.getState().setThreadModel(threadId, model).catch(reportError('model change failed'));
  }, []);
  const onEffortChange = useCallback((threadId: string, effort: EffortLevel | null) => {
    void useAppStore.getState().setThreadEffort(threadId, effort).catch(reportError('effort change failed'));
  }, []);
  const onPermissionModeChange = useCallback((threadId: string, mode: UiPermissionMode) => {
    setSendError(null);
    void useAppStore
      .getState()
      .setThreadPermissionMode(threadId, mode)
      .catch((err: unknown) => setSendError(`권한 모드를 바꾸지 못했습니다: ${ipcErrorMessage(err)}`));
  }, []);
  // 더보기 > 계정 고정: the open thread's pin, or the draft's before the thread exists.
  const onPinAccount = useCallback((accountId: string | null) => {
    const s = useAppStore.getState();
    if (s.route === 'chat' && s.selectedThreadId) {
      void s.pinAccount(s.selectedThreadId, accountId).catch(reportError('account pin failed'));
    } else {
      s.setDraft({ pinnedAccountId: accountId });
    }
  }, []);
  const onAttachToThread = useCallback((threadId: string) => useAppStore.getState().pickFiles({ threadId }), []);
  const onAttachToDraft = useCallback((projectId: string) => useAppStore.getState().pickFiles({ projectId }), []);

  const activePage: NavPage = route === 'chat' ? (activeThread ? null : 'draft') : route;
  // Statusline model: the thread's (resolved) model, or what the draft will start with.
  const statusModel = activeThread
    ? concreteModelLabel(activeThread.model, models, { resolvedModel: activeThread.resolvedModel, defaultLabel: defaultModelLabel })
    : route === 'chat'
      ? concreteModelLabel(draft.model, models, { defaultLabel: defaultModelLabel })
      : null;
  const activeProject = activeThread ? (projects.find((p) => p.id === activeThread.projectId) ?? null) : null;
  // The panel belongs to the conversation view; other routes keep it closed without forgetting the tab.
  const shownPanel = route === 'chat' ? panel : null;
  const profileAccount = useMemo(() => {
    const byId = activeThread?.activeAccountId ? accounts.find((a) => a.id === activeThread.activeAccountId) : undefined;
    return byId ?? [...accounts].filter((a) => a.enabled).sort((a, b) => a.priority - b.priority)[0] ?? accounts[0] ?? null;
  }, [accounts, activeThread?.activeAccountId]);

  const paletteCommands = useMemo<PaletteCommand[]>(() => {
    const s = () => useAppStore.getState();
    const byProject = new Map(projects.map((p) => [p.id, p.name]));
    const threadItems: PaletteCommand[] = [...threads]
      .filter((t) => !t.archived)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((t) => ({
        id: `thread:${t.id}`,
        title: t.title,
        subtitle: byProject.get(t.projectId),
        group: '스레드',
        // Title and first message are both searchable (⌘K / 검색).
        keywords: [byProject.get(t.projectId) ?? '', firstMessages[t.id] ?? ''],
        run: () => onSelectThread(t.id),
      }));
    const primaryEditor = editors.find((e) => e.id === settings.defaultEditor) ?? editors[0];
    const actions: PaletteCommand[] = [
      { id: 'new-chat', title: '새 채팅', group: '작업', shortcut: '⌘N', keywords: ['new', 'chat', 'draft'], run: () => s().newDraft() },
      {
        id: 'new-task-start',
        title: 'New Task Start',
        group: '작업',
        shortcut: '⌘⇧N',
        icon: <BoltIcon />,
        keywords: ['new task', 'start', 'template', 'worktree'],
        run: () => s().startNewTask(),
      },
      { id: 'settings', title: '설정', group: '작업', shortcut: '⌘,', icon: <GlyphSettings />, keywords: ['settings', 'preferences'], run: onOpenSettings },
      { id: 'accounts', title: '계정 관리', group: '작업', icon: <GlyphPeople />, keywords: ['accounts'], run: onOpenAccounts },
      { id: 'usage', title: '사용량', group: '작업', icon: <GlyphChart />, keywords: ['usage', 'limit'], run: onOpenUsage },
      { id: 'prs', title: '풀 리퀘스트', group: '작업', icon: <IconPullRequest />, keywords: ['pull request', 'pr', 'github', 'gh'], run: onOpenPrs },
      { id: 'schedule', title: '예약', group: '작업', icon: <IconClock />, keywords: ['schedule', 'cron', 'automation'], run: onOpenSchedule },
      { id: 'plugins', title: '플러그인', group: '작업', icon: <IconPlug />, keywords: ['plugins', 'skills', 'mcp', 'hooks'], run: onOpenPlugins },
      {
        id: 'panel-changes',
        title: panel === 'changes' ? '변경사항 패널 닫기' : '변경사항 패널 열기',
        group: '패널',
        shortcut: '⌘⇧D',
        icon: <GlyphChanges />,
        keywords: ['changes', 'diff', 'git'],
        run: () => {
          s().setRoute('chat');
          s().togglePanel('changes');
        },
      },
      {
        id: 'panel-terminal',
        title: panel === 'terminal' ? '터미널 닫기' : '터미널 열기',
        group: '패널',
        shortcut: '⌘J',
        icon: <GlyphTerminal />,
        keywords: ['terminal', 'shell'],
        run: () => {
          s().setRoute('chat');
          s().togglePanel('terminal');
        },
      },
      ...(activeThread && primaryEditor
        ? [
            {
              id: 'open-editor',
              title: `${primaryEditor.name}에서 열기`,
              subtitle: activeThread.title,
              group: '패널',
              icon: <GlyphCode />,
              keywords: ['editor', 'open', 'vscode', 'cursor'],
              run: () => onOpenEditor(primaryEditor.id),
            },
          ]
        : []),
      { id: 'sidebar', title: sidebarCollapsed ? '사이드바 보기' : '사이드바 숨기기', group: '보기', shortcut: '⌘B', keywords: ['sidebar'], run: onToggleSidebar },
      { id: 'shortcuts', title: '키보드 단축키', group: '보기', icon: <GlyphKeyboard />, keywords: ['shortcuts', 'keys'], run: onShowShortcuts },
      { id: 'about', title: '앱 정보', group: '보기', icon: <GlyphInfo />, keywords: ['about', 'version'], run: onShowAbout },
    ];
    // Threads first: the palette opens as thread search; commands follow in the same list.
    return [...threadItems, ...actions];
  }, [
    projects,
    threads,
    firstMessages,
    onOpenPrs,
    onOpenSchedule,
    onOpenPlugins,
    editors,
    settings.defaultEditor,
    panel,
    activeThread,
    sidebarCollapsed,
    onSelectThread,
    onOpenSettings,
    onOpenAccounts,
    onOpenUsage,
    onOpenEditor,
    onToggleSidebar,
    onShowShortcuts,
    onShowAbout,
  ]);

  // The palette offers "에디터에서 열기" from the start.
  useEffect(() => {
    if (paletteOpen && editors.length === 0) onLoadEditors();
  }, [paletteOpen, editors.length, onLoadEditors]);

  // Thread search also matches each thread's first message (read from the logs in main on every open).
  useEffect(() => {
    if (!paletteOpen) return;
    void invoke('nav:threadFirstMessages').then(setFirstMessages).catch(reportError('thread search index failed'));
  }, [paletteOpen]);

  const shellClass = [
    'app',
    shownPanel === 'terminal' ? 'app--terminal-open' : 'app--terminal-closed',
    shownPanel ? 'app--panel-open' : 'app--panel-closed',
    sidebarCollapsed ? 'app--sidebar-collapsed' : '',
    resizing ? 'app--resizing' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const archivedCount = useMemo(() => threads.filter((t) => t.archived).length, [threads]);

  return (
    <div className={shellClass} style={{ ['--app-panel-w' as string]: shownPanel ? `${panelWidth}px` : '0px' }}>
      <aside className="app__sidebar" data-testid="sidebar" aria-hidden={sidebarCollapsed} inert={sidebarCollapsed}>
        <div className="app__sidebar-card">
          <div className="app__titlebar app__titlebar--sidebar drag-region">
            <WindowButton label="사이드바 숨기기 (⌘B)" onClick={onToggleSidebar}>
              <IconSidebar />
            </WindowButton>
          </div>
          <div className="app__body">
            <Sidebar
              projects={projects}
              threads={threads}
              accounts={accounts}
              selectedThreadId={route === 'chat' ? selectedThreadId : null}
              activePage={activePage}
              unseenDone={unseenDone}
              onNewChat={onNewChat}
              onNewChatIn={onNewChatIn}
              onSearch={onOpenSearch}
              onOpenPrs={onOpenPrs}
              onOpenSchedule={onOpenSchedule}
              onOpenPlugins={onOpenPlugins}
              onOpenAccounts={onOpenAccounts}
              onOpenUsage={onOpenUsage}
              onOpenSettings={onOpenSettings}
              onShowShortcuts={onShowShortcuts}
              onShowAbout={onShowAbout}
              onAddProject={onAddProject}
              onSelectThread={onSelectThread}
              onRenameThread={onRenameThread}
              onSetPinned={onSetPinned}
              onSetArchived={onSetArchived}
              onDeleteThread={onDeleteThread}
              onRemoveProject={onRemoveProject}
              onSetProjectTrusted={onSetProjectTrusted}
              footer={
                <ProfileRow
                  account={profileAccount}
                  accounts={accounts}
                  pool={pool.summary}
                  onOpenDataFolder={onOpenDataFolder}
                  onQuit={onQuit}
                  onAddAccount={onAddAccount}
                />
              }
            />
          </div>
        </div>
      </aside>
      <main className="app__chat" data-testid="chat">
        <div
          className={`app__titlebar app__titlebar--chat drag-region${route === 'chat' && activeThread && chatScrolled ? ' app__titlebar--scrolled' : ''}`}
        >
          {sidebarCollapsed ? (
            <div className="app__window-actions">
              <WindowButton label="사이드바 보기 (⌘B)" onClick={onToggleSidebar}>
                <IconSidebar />
              </WindowButton>
              <WindowButton label="새 채팅 (⌘N)" onClick={onNewChat}>
                <IconCompose />
              </WindowButton>
            </div>
          ) : null}
          {/* The Accounts / Settings pages carry their own headings; the bar stays a drag region. */}
          {route === 'chat' && activeThread ? (
            <ChatHeader
              thread={activeThread}
              project={activeProject}
              accounts={accounts}
              draftPinnedAccountId={draft.pinnedAccountId}
              panel={shownPanel}
              editors={editors}
              defaultEditor={settings.defaultEditor}
              homeDir={homeDir}
              onRename={onRenameActive}
              onTogglePanel={onTogglePanel}
              onOpenEditor={onOpenEditor}
              onLoadEditors={onLoadEditors}
              onPinAccount={onPinAccount}
              onSetPinned={onSetPinned}
              onSetArchived={onSetArchived}
              onDeleteThread={onDeleteThread}
            />
          ) : route === 'chat' ? (
            <div className="hc-chat-header hc-chat-header--draft">
              <div className="app__thread-title" />
              <WindowToolbar
                thread={null}
                project={null}
                accounts={accounts}
                draftPinnedAccountId={draft.pinnedAccountId}
                panel={shownPanel}
                editors={editors}
                defaultEditor={settings.defaultEditor}
                homeDir={homeDir}
                onTogglePanel={onTogglePanel}
                onOpenEditor={onOpenEditor}
                onLoadEditors={onLoadEditors}
                onPinAccount={onPinAccount}
                onSetPinned={onSetPinned}
                onSetArchived={onSetArchived}
                onDeleteThread={onDeleteThread}
              />
            </div>
          ) : null}
        </div>
        <div className="app__body app__body--fill">
          <div className="app__view" key={route === 'chat' ? (activeThread ? `thread:${activeThread.id}` : 'draft') : route}>
            {route === 'accounts' ? (
              <AccountsRoute addRequest={addAccountRequest} />
            ) : route === 'prs' ? (
              <PullRequestsPage
                threads={threads}
                projects={projects}
                onBack={onBackToChat}
                onOpenThread={onSelectThread}
                onNewChatFromPr={onNewChatFromPr}
              />
            ) : route === 'schedule' ? (
              <SchedulePage
                projects={projects}
                threads={threads}
                models={models}
                defaultModel={settings.defaultModel}
                onBack={onBackToChat}
                onOpenThread={onSelectThread}
              />
            ) : route === 'plugins' ? (
              <PluginsPage homeDir={homeDir} onBack={onBackToChat} />
            ) : route === 'settings' ? (
              <SettingsPage
                settings={settings}
                models={models}
                accounts={accounts}
                archivedCount={archivedCount}
                homeDir={homeDir}
                defaultModelLabel={defaultModelLabel}
                onUpdate={(patch) => useAppStore.getState().updateSettings(patch)}
                onDeleteArchived={() => useAppStore.getState().deleteArchivedThreads()}
                onOpenDataFolder={openDataFolder}
                loadDataDir={loadDataDir}
                loadEditors={loadEditorList}
                loadSharedStatus={loadSharedStatus}
                relinkShared={relinkShared}
                onBack={() => useAppStore.getState().setRoute('chat')}
              />
            ) : activeThread ? (
              <ChatView
                thread={activeThread}
                project={activeProject}
                models={models}
                onSend={onSend}
                onInterrupt={onInterrupt}
                onPermissionDecision={onPermissionDecision}
                onModelChange={onModelChange}
                onEffortChange={onEffortChange}
                onPermissionModeChange={onPermissionModeChange}
                onAttachFiles={onAttachToThread}
                defaultModelLabel={defaultModelLabel}
                homeDir={homeDir}
              />
            ) : (
              <DraftView
                draft={draft}
                projects={projects}
                models={models}
                onDraftChange={onDraftChange}
                onPickFolder={onPickFolder}
                onStart={onStartThread}
                onAttachFiles={onAttachToDraft}
                defaultModelLabel={defaultModelLabel}
                homeDir={homeDir}
              />
            )}
          </div>
          {sendError && route === 'chat' ? (
            <div className="app__toast hc-notice hc-notice--error" role="alert" onClick={() => setSendError(null)}>
              {sendError}
            </div>
          ) : null}
        </div>
      </main>
      <section className="app__panel" aria-label="오른쪽 패널">
        <RightPanel
          tab={shownPanel}
          thread={activeThread}
          terminalSessionId={activeThread?.id ?? DRAFT_PTY_SESSION_ID}
          draftProjectId={draft.projectId}
          width={panelWidth}
          onTab={onSelectTab}
          onClose={onClosePanel}
          onResize={onResizePanel}
          onResizing={setResizing}
        />
      </section>
      <StatusLine pool={pool} accounts={accounts} activeThread={activeThread} models={models} modelText={statusModel} />
      <CommandPalette
        open={paletteOpen}
        onClose={() => useAppStore.getState().setPaletteOpen(false)}
        commands={paletteCommands}
        placeholder="스레드 제목·내용 검색 또는 명령 실행…"
      />
      <ShortcutsModal open={modal === 'shortcuts'} onClose={onCloseModal} />
      <AboutModal open={modal === 'about'} onClose={onCloseModal} loadInfo={loadAppInfo} homeDir={homeDir} />
    </div>
  );
}

function WindowButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className="app__window-btn no-drag" aria-label={label} title={label} onClick={onClick}>
      {children}
    </button>
  );
}

/** Drops renderer-side per-thread state after a thread (or its project) was deleted. */
function forgetThread(threadId: string): void {
  disposeTerminalEntry(threadId);
  forgetTerminalSize(threadId);
  historyRequested.delete(threadId);
}

// ---------------------------------------------------------------------------
// Accounts route: AccountsPage + AddAccountDialog (account:loginStart/Input/Cancel <-> login:data/exit).
// ---------------------------------------------------------------------------

/** `addRequest` bumps when "계정 추가" is chosen elsewhere (profile row): the add dialog opens. */
function AccountsRoute({ addRequest }: { addRequest: number }) {
  const accounts = useAppStore(selectAccounts);
  const pool = useAppStore(selectPoolSnapshot);
  const focus = useAppStore((s) => s.accountsFocus);
  const now = useNow(30_000);
  const [history, setHistory] = useState<Record<string, UsageSample[]>>(() => cachedUsageHistory());

  const [dialogOpen, setDialogOpen] = useState(false);
  const [alias, setAlias] = useState('');
  const [color, setColor] = useState<string>(ACCOUNT_COLORS[0] ?? '#007AFF');
  const [loginId, setLoginId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [inputValue, setInputValue] = useState('');
  const login = useAppStore((s) => (loginId ? s.loginSessions[loginId] : undefined));

  // L9: usage history is fetched only while this route is mounted, and per account at most once per
  // USAGE_HISTORY_REFRESH_MS (pool updates re-run the check but rarely refetch).
  const accountIds = accounts.map((a) => a.id).join(',');
  const poolAt = pool.at;
  useEffect(() => {
    const ids = accountIds ? accountIds.split(',') : [];
    const t = Date.now();
    for (const id of ids) {
      const cached = usageHistoryCache.get(id);
      if (cached && t - cached.at < USAGE_HISTORY_REFRESH_MS) continue;
      // Stamp before the request so a pool update while it is in flight does not refetch.
      usageHistoryCache.set(id, { at: t, samples: cached?.samples ?? [] });
      useAppStore
        .getState()
        .fetchUsageHistory(id, USAGE_HISTORY_RANGE_MS)
        .then((samples) => {
          usageHistoryCache.set(id, { at: Date.now(), samples });
          setHistory(cachedUsageHistory());
        })
        .catch((err: unknown) => {
          usageHistoryCache.set(id, { at: 0, samples: cached?.samples ?? [] });
          console.error('[hopecode] usage history failed', err);
        });
    }
  }, [accountIds, poolAt]);

  let status: LoginStatus = 'form';
  if (startError) status = 'error';
  else if (starting) status = 'starting';
  else if (login) {
    if (!login.done) status = 'running';
    else if (login.ok) status = 'success';
    else status = login.error === 'cancelled' ? 'cancelled' : 'error';
  }

  const resetDialog = () => {
    if (loginId) useAppStore.getState().clearLoginSession(loginId);
    setLoginId(null);
    setStarting(false);
    setStartError(null);
    setInputValue('');
  };

  const openAddDialog = () => {
    resetDialog();
    setAlias('');
    setColor(ACCOUNT_COLORS[accounts.length % ACCOUNT_COLORS.length] ?? '#007AFF');
    setDialogOpen(true);
  };

  useEffect(() => {
    if (addRequest > 0) openAddDialog();
    // Only a new request opens the dialog; the dialog's own state changes must not re-open it.
  }, [addRequest]);

  const onStart = () => {
    const trimmed = alias.trim();
    if (!trimmed) return;
    setStarting(true);
    setStartError(null);
    void useAppStore
      .getState()
      .startLogin(trimmed, color)
      .then((r) => setLoginId(r.loginId))
      .catch((err: unknown) => setStartError(String(err)))
      .finally(() => setStarting(false));
  };

  return (
    <>
      <AccountsPage
        accounts={accounts}
        usageById={pool.usageById}
        usageHistoryByAccount={history}
        now={now}
        onReorder={(ids) => void useAppStore.getState().reorderAccounts(ids)}
        onUpdateAccount={(id, patch) => void useAppStore.getState().updateAccount(id, patch)}
        onRemoveAccount={(id) => useAppStore.getState().removeAccount(id)}
        onAddAccount={openAddDialog}
        onBack={() => useAppStore.getState().setRoute('chat')}
        focusUsage={focus === 'usage'}
        onFocused={() => useAppStore.getState().clearAccountsFocus()}
      />
      <AddAccountDialog
        open={dialogOpen}
        status={status}
        alias={alias}
        onAliasChange={setAlias}
        color={color}
        onColorChange={setColor}
        onStart={onStart}
        output={login?.output ?? ''}
        loginInputValue={inputValue}
        onLoginInputChange={setInputValue}
        onSubmitInput={() => {
          if (!loginId || !inputValue.trim()) return;
          void useAppStore.getState().loginInput(loginId, `${inputValue.trim()}\r`);
          setInputValue('');
        }}
        onCancel={() => {
          if (loginId && login && !login.done) void useAppStore.getState().cancelLogin(loginId);
        }}
        onClose={() => {
          resetDialog();
          setDialogOpen(false);
        }}
        onRetry={resetDialog}
        account={login?.account ?? null}
        errorMessage={startError ?? login?.error ?? null}
      />
    </>
  );
}
