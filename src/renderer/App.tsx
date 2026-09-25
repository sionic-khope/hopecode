import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { concreteModelLabel, defaultModelLabelFrom } from '../core/modelDisplay';
import './App.css';
import { on } from './api';
import { AccountsPage } from './components/Accounts/AccountsPage';
import { AddAccountDialog, type LoginStatus } from './components/Accounts/AddAccountDialog';
import { ChatView, DraftView } from './components/Chat';
import { NEEDS_FORCE } from './components/Sidebar/ItemMenu';
import { Sidebar } from './components/Sidebar/Sidebar';
import { IconCompose, IconSidebar } from './components/Sidebar/icons';
import { StatusLine } from './components/StatusLine/StatusLine';
import { Button } from './components/common';
import { TerminalPane } from './components/Terminal/TerminalPane';
import { disposeTerminalEntry, resetTerminalEntry } from './components/Terminal/terminalRegistry';
import { ipcErrorMessage } from './errors';
import {
  initStoreEventSubscriptions,
  selectAccounts,
  selectChatScrolled,
  selectDraft,
  selectHomeDir,
  selectModels,
  selectPoolSnapshot,
  selectProjects,
  selectRoute,
  selectSelectedThread,
  selectPtyStatus,
  selectSelectedThreadId,
  selectSidebarCollapsed,
  selectTerminalOpen,
  selectThreads,
  useAppStore,
} from './store';
import { ACCOUNT_COLORS, DAY_MS, MINUTE_MS } from '../shared/constants';
import type { ChatSendResult, EffortLevel, PermissionDecision, UiPermissionMode, UsageSample } from '../shared/types';

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

/** Shell: sidebar (⌘B) | chat, draft or accounts | terminal (⌘J), bottom statusline. */
export function App() {
  const projects = useAppStore(selectProjects);
  const threads = useAppStore(selectThreads);
  const accounts = useAppStore(selectAccounts);
  const pool = useAppStore(selectPoolSnapshot);
  const models = useAppStore(selectModels);
  const route = useAppStore(selectRoute);
  const terminalOpen = useAppStore(selectTerminalOpen);
  const sidebarCollapsed = useAppStore(selectSidebarCollapsed);
  const selectedThreadId = useAppStore(selectSelectedThreadId);
  const activeThread = useAppStore(selectSelectedThread);
  const draft = useAppStore(selectDraft);
  const homeDir = useAppStore(selectHomeDir);
  const chatScrolled = useAppStore(selectChatScrolled);
  const defaultModelLabel = useMemo(() => defaultModelLabelFrom(threads), [threads]);

  const [sendError, setSendError] = useState<string | null>(null);

  // Store <-> main wiring, once per mount. ⌘N / ⌘B / ⌘J come only from the app menu (`ui:newThread`,
  // `ui:toggleSidebar`, `ui:toggleTerminal` in store/events.ts), so each shortcut runs exactly once.
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

  const onSend = useCallback((threadId: string, text: string) => {
    setSendError(null);
    void useAppStore
      .getState()
      .sendMessage(threadId, text)
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

  const onOpenAccounts = useCallback(() => useAppStore.getState().setRoute('accounts'), []);
  const onToggleSidebar = useCallback(() => useAppStore.getState().toggleSidebar(), []);

  const onRenameThread = useCallback((threadId: string, title: string) => useAppStore.getState().renameThread(threadId, title), []);
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
  const onPinAccountChange = useCallback((threadId: string, accountId: string | null) => {
    void useAppStore.getState().pinAccount(threadId, accountId).catch(reportError('account pin failed'));
  }, []);
  const onAttachToThread = useCallback((threadId: string) => useAppStore.getState().pickFiles({ threadId }), []);
  const onAttachToDraft = useCallback((projectId: string) => useAppStore.getState().pickFiles({ projectId }), []);

  const draftActive = route === 'chat' && !activeThread;
  // Statusline model: the thread's (resolved) model, or what the draft will start with.
  const statusModel = activeThread
    ? concreteModelLabel(activeThread.model, models, { resolvedModel: activeThread.resolvedModel, defaultLabel: defaultModelLabel })
    : route === 'chat'
      ? concreteModelLabel(draft.model, models, { defaultLabel: defaultModelLabel })
      : null;
  const activeProject = activeThread ? (projects.find((p) => p.id === activeThread.projectId) ?? null) : null;
  const shellClass = [
    'app',
    terminalOpen ? 'app--terminal-open' : 'app--terminal-closed',
    sidebarCollapsed ? 'app--sidebar-collapsed' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={shellClass}>
      <aside className="app__sidebar" data-testid="sidebar" aria-hidden={sidebarCollapsed} inert={sidebarCollapsed}>
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
            draftActive={draftActive}
            accountsActive={route === 'accounts'}
            onNewChat={onNewChat}
            onNewChatIn={onNewChatIn}
            onOpenAccounts={onOpenAccounts}
            onAddProject={onAddProject}
            onSelectThread={onSelectThread}
            onRenameThread={onRenameThread}
            onSetPinned={onSetPinned}
            onSetArchived={onSetArchived}
            onDeleteThread={onDeleteThread}
            onRemoveProject={onRemoveProject}
            onSetProjectTrusted={onSetProjectTrusted}
          />
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
          {/* The Accounts page and the draft screen carry their own headings; the bar stays a drag region. */}
          {route === 'chat' && activeThread ? (
            <div className="app__thread-title">
              <span className="app__thread-name">{activeThread.title}</span>
              {activeProject ? <span className="app__thread-project">{activeProject.name}</span> : null}
            </div>
          ) : null}
        </div>
        <div className="app__body app__body--fill">
          {route === 'accounts' ? (
            <AccountsRoute />
          ) : activeThread ? (
            <ChatView
              key={activeThread.id}
              thread={activeThread}
              project={activeProject}
              models={models}
              accounts={accounts}
              onSend={onSend}
              onInterrupt={onInterrupt}
              onPermissionDecision={onPermissionDecision}
              onModelChange={onModelChange}
              onEffortChange={onEffortChange}
              onPermissionModeChange={onPermissionModeChange}
              onPinAccountChange={onPinAccountChange}
              onAttachFiles={onAttachToThread}
              defaultModelLabel={defaultModelLabel}
              homeDir={homeDir}
            />
          ) : (
            <DraftView
              draft={draft}
              projects={projects}
              models={models}
              accounts={accounts}
              onDraftChange={onDraftChange}
              onPickFolder={onPickFolder}
              onStart={onStartThread}
              onAttachFiles={onAttachToDraft}
              defaultModelLabel={defaultModelLabel}
              homeDir={homeDir}
            />
          )}
          {sendError && route === 'chat' ? (
            <div className="app__toast hc-notice hc-notice--error" role="alert" onClick={() => setSendError(null)}>
              {sendError}
            </div>
          ) : null}
        </div>
      </main>
      <section className="app__terminal" data-testid="terminal" aria-hidden={!terminalOpen}>
        <div className="app__titlebar drag-region" />
        <div className="app__body app__body--fill">
          {terminalOpen && activeThread ? <ThreadTerminal threadId={activeThread.id} /> : null}
        </div>
      </section>
      <StatusLine pool={pool} accounts={accounts} activeThread={activeThread} models={models} modelText={statusModel} />
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
  lastTerminalSize.delete(threadId);
  historyRequested.delete(threadId);
}

// ---------------------------------------------------------------------------
// Terminal: pty:open replay seeds the xterm once, pty:data (filtered by thread) streams live output.
// ---------------------------------------------------------------------------

const lastTerminalSize = new Map<string, { cols: number; rows: number }>();

const subscribeOutput = (threadId: string, onChunk: (data: string) => void) =>
  on('pty:data', (payload) => {
    if (payload.threadId === threadId) onChunk(payload.data);
  });

const getInitialContent = async (threadId: string) => {
  const size = lastTerminalSize.get(threadId) ?? { cols: 80, rows: 24 };
  const { replay } = await useAppStore.getState().openTerminal(threadId, size.cols, size.rows);
  return replay;
};

function ThreadTerminal({ threadId }: { threadId: string }) {
  const pty = useAppStore((s) => selectPtyStatus(s, threadId));
  // Bumped by Restart: remounts TerminalPane, which re-seeds the (reset) entry from a fresh `pty:open`.
  const [generation, setGeneration] = useState(0);
  const exited = pty !== undefined && !pty.running;

  const onResize = useCallback(
    (cols: number, rows: number) => {
      lastTerminalSize.set(threadId, { cols, rows });
      void useAppStore.getState().resizeTerminal(threadId, cols, rows);
    },
    [threadId],
  );
  return (
    <div className="app__terminal-host">
      <TerminalPane
        key={generation}
        sessionId={threadId}
        onData={(data) => {
          if (!exited) void useAppStore.getState().writeTerminal(threadId, data);
        }}
        subscribeOutput={subscribeOutput}
        getInitialContent={getInitialContent}
        onResize={onResize}
      />
      {exited ? (
        <div className="app__terminal-exited" role="status">
          <span>셸이 종료되었습니다{pty.lastExitCode ? ` (코드 ${pty.lastExitCode})` : ''}</span>
          <span aria-hidden>·</span>
          <Button variant="secondary" size="sm" onClick={() => setGeneration((g) => g + 1)}>
            다시 시작
          </Button>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Accounts route: AccountsPage + AddAccountDialog (account:loginStart/Input/Cancel <-> login:data/exit).
// ---------------------------------------------------------------------------

function AccountsRoute() {
  const accounts = useAppStore(selectAccounts);
  const pool = useAppStore(selectPoolSnapshot);
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
        onAddAccount={() => {
          resetDialog();
          setAlias('');
          setColor(ACCOUNT_COLORS[accounts.length % ACCOUNT_COLORS.length] ?? '#007AFF');
          setDialogOpen(true);
        }}
        onBack={() => useAppStore.getState().setRoute('chat')}
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
