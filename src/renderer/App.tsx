import { useCallback, useEffect, useState } from 'react';
import './App.css';
import { on } from './api';
import { AccountsPage } from './components/Accounts/AccountsPage';
import { AddAccountDialog, type LoginStatus } from './components/Accounts/AddAccountDialog';
import { ChatView } from './components/Chat';
import { NEEDS_FORCE } from './components/Sidebar/ItemMenu';
import { Sidebar } from './components/Sidebar/Sidebar';
import { StatusLine } from './components/StatusLine/StatusLine';
import { BrandMark, Button } from './components/common';
import { TerminalPane } from './components/Terminal/TerminalPane';
import { disposeTerminalEntry, resetTerminalEntry } from './components/Terminal/terminalRegistry';
import { ipcErrorMessage } from './errors';
import {
  initStoreEventSubscriptions,
  selectAccounts,
  selectModels,
  selectPoolSnapshot,
  selectProjects,
  selectRoute,
  selectSelectedThread,
  selectPtyStatus,
  selectSelectedThreadId,
  selectTerminalOpen,
  selectThreads,
  useAppStore,
} from './store';
import { ACCOUNT_COLORS, APP_NAME, DAY_MS, MINUTE_MS } from '../shared/constants';
import type { ChatSendResult, PermissionDecision, UiPermissionMode, UsageSample } from '../shared/types';

const USAGE_HISTORY_RANGE_MS = 7 * DAY_MS;
const USAGE_HISTORY_REFRESH_MS = 5 * MINUTE_MS;
/** Last `usage:history` result per account (renderer session). */
const usageHistoryCache = new Map<string, { at: number; samples: UsageSample[] }>();

function cachedUsageHistory(): Record<string, UsageSample[]> {
  return Object.fromEntries([...usageHistoryCache].map(([id, entry]) => [id, entry.samples]));
}
/** Threads whose `chat:history` was requested in this renderer session. */
const historyRequested = new Set<string>();

function sendErrorMessage(result: ChatSendResult): string | null {
  if (result.accepted) return null;
  switch (result.reason) {
    case 'busy':
      return 'This thread is still running. Wait for the turn to finish or press Stop.';
    case 'no-accounts':
      return 'No enabled account. Add or enable an account on the Accounts page.';
    case 'auth':
      return 'Every account needs to log in again. Re-login on the Accounts page.';
    default:
      return 'The message was not sent.';
  }
}

/** Creates a thread in the selected (or first) project; with no project, asks for a folder first. */
async function newThread(): Promise<void> {
  const s = useAppStore.getState();
  const selected = selectSelectedThread(s);
  let projectId = selected?.projectId ?? s.projects[0]?.id ?? null;
  if (!projectId) {
    const project = await s.addProject();
    if (!project) return;
    projectId = project.id;
  }
  await s.createThread(projectId);
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** 3-pane shell: sidebar | chat or accounts | terminal (⌘J), bottom statusline. */
export function App() {
  const projects = useAppStore(selectProjects);
  const threads = useAppStore(selectThreads);
  const accounts = useAppStore(selectAccounts);
  const pool = useAppStore(selectPoolSnapshot);
  const models = useAppStore(selectModels);
  const route = useAppStore(selectRoute);
  const terminalOpen = useAppStore(selectTerminalOpen);
  const selectedThreadId = useAppStore(selectSelectedThreadId);
  const activeThread = useAppStore(selectSelectedThread);

  const [sendError, setSendError] = useState<string | null>(null);

  // Store <-> main wiring, once per mount. ⌘N / ⌘J come only from the app menu (`ui:newThread`,
  // `ui:toggleTerminal` in store/events.ts), so each shortcut runs exactly once.
  useEffect(() => {
    const off = initStoreEventSubscriptions();
    const offNewThread = on('ui:newThread', () => void newThread().catch((err: unknown) => console.error(err)));
    const offPtyExit = on('pty:exit', ({ threadId }) => resetTerminalEntry(threadId));
    void useAppStore
      .getState()
      .bootstrap()
      .then(() => useAppStore.getState().loadModels())
      .catch((err: unknown) => console.error('[hopecode] bootstrap failed', err));
    return () => {
      off();
      offNewThread();
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

  useEffect(() => setSendError(null), [selectedThreadId]);

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
      // `{accepted:true, reason:'waiting'}`: queued behind the pool reset; the thread shows Waiting.
      .then((result) => setSendError(sendErrorMessage(result)))
      .catch((err: unknown) => setSendError(`The message was not sent: ${ipcErrorMessage(err)}`));
  }, []);

  const onNewThread = useCallback((projectId: string) => {
    void useAppStore
      .getState()
      .createThread(projectId)
      .catch((err: unknown) => console.error(err));
  }, []);

  const onAddProject = useCallback(() => {
    void useAppStore
      .getState()
      .addProject()
      .catch((err: unknown) => console.error(err));
  }, []);

  const onOpenAccounts = useCallback(() => useAppStore.getState().setRoute('accounts'), []);

  const onRenameThread = useCallback((threadId: string, title: string) => useAppStore.getState().renameThread(threadId, title), []);

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
    void useAppStore
      .getState()
      .setProjectTrusted(projectId, trusted)
      .catch((err: unknown) => console.error('[hopecode] trust change failed', err));
  }, []);

  const onInterrupt = useCallback((threadId: string) => void useAppStore.getState().interrupt(threadId), []);
  const onPermissionDecision = useCallback(
    (requestId: string, decision: PermissionDecision) => void useAppStore.getState().respondPermission(requestId, decision),
    [],
  );
  const onModelChange = useCallback(
    (threadId: string, model: string) => void useAppStore.getState().setThreadModel(threadId, model),
    [],
  );
  const onPermissionModeChange = useCallback((threadId: string, mode: UiPermissionMode) => {
    setSendError(null);
    void useAppStore
      .getState()
      .setThreadPermissionMode(threadId, mode)
      .catch((err: unknown) => setSendError(`Permission mode was not changed: ${ipcErrorMessage(err)}`));
  }, []);
  const onPinAccountChange = useCallback(
    (threadId: string, accountId: string | null) => void useAppStore.getState().pinAccount(threadId, accountId),
    [],
  );

  return (
    <div className={`app ${terminalOpen ? 'app--terminal-open' : 'app--terminal-closed'}`}>
      <aside className="app__sidebar" data-testid="sidebar">
        <div className="app__titlebar drag-region">
          <div className="app__brand" data-testid="brand">
            <BrandMark size={18} />
            <span className="app__wordmark">
              Hope<span className="app__wordmark-code">code</span>
            </span>
          </div>
        </div>
        <div className="app__body">
          <Sidebar
            projects={projects}
            threads={threads}
            accounts={accounts}
            selectedThreadId={route === 'chat' ? selectedThreadId : null}
            onSelectThread={onSelectThread}
            onNewThread={onNewThread}
            onRenameThread={onRenameThread}
            onDeleteThread={onDeleteThread}
            onRemoveProject={onRemoveProject}
            onSetProjectTrusted={onSetProjectTrusted}
            onAddProject={onAddProject}
            onOpenAccounts={onOpenAccounts}
            accountsActive={route === 'accounts'}
          />
        </div>
      </aside>
      <main className="app__chat" data-testid="chat">
        {/* The Accounts page has its own header; the bar stays an empty drag region there. */}
        <div className="app__titlebar drag-region">{route === 'accounts' ? null : (activeThread?.title ?? APP_NAME)}</div>
        <div className="app__body app__body--fill">
          {route === 'accounts' ? (
            <AccountsRoute />
          ) : activeThread ? (
            <>
              <ChatView
                key={activeThread.id}
                thread={activeThread}
                models={models}
                accounts={accounts}
                onSend={onSend}
                onInterrupt={onInterrupt}
                onPermissionDecision={onPermissionDecision}
                onModelChange={onModelChange}
                onPermissionModeChange={onPermissionModeChange}
                onPinAccountChange={onPinAccountChange}
              />
              {sendError ? (
                <div className="app__toast hc-notice hc-notice--error" role="alert" onClick={() => setSendError(null)}>
                  {sendError}
                </div>
              ) : null}
            </>
          ) : (
            <div className="app__empty">
              {projects.length === 0 ? 'Add a project folder to start' : 'Select or create a thread (⌘N)'}
            </div>
          )}
        </div>
      </main>
      <section className="app__terminal" data-testid="terminal" aria-hidden={!terminalOpen}>
        <div className="app__titlebar drag-region" />
        <div className="app__body app__body--fill">
          {terminalOpen && activeThread ? <ThreadTerminal threadId={activeThread.id} /> : null}
        </div>
      </section>
      <StatusLine pool={pool} accounts={accounts} activeThread={activeThread} models={models} />
    </div>
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
          <span>Shell exited{pty.lastExitCode ? ` (code ${pty.lastExitCode})` : ''}</span>
          <span aria-hidden>·</span>
          <Button variant="secondary" size="sm" onClick={() => setGeneration((g) => g + 1)}>
            Restart
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
