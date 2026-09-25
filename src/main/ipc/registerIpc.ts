// Wires the plan 3.3 invoke contract to injected services (plan 4.2 `ipc/register.ts`).
// `IpcMainLike` mirrors the slice of `Electron.IpcMain` this module needs, so registerIpc can be
// exercised in plain Node tests with a fake — no Electron runtime import here.
// Service *construction and wiring* (DI) happens in Wave 3 (src/main/index.ts); this module only
// maps each of the 25 invoke channels onto the service methods it's given, validating input and
// performing the small bits of orchestration (project/thread CRUD, pin) that no single Wave 1/2
// service owns.
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { INVOKE_CHANNELS, type InvokeChannel, type InvokeResponse } from '../../shared/ipc';
import type {
  AccountPool,
  Broadcaster,
  Dialogs,
  PtyManager,
  SessionManager,
  Store,
  ThreadLog,
  Unsubscribe,
  UsageHistory,
  UsagePoller,
  WorktreeManager,
} from '../contracts';
import type { SyncTranscriptFn } from '../session/transcriptSync';
import { USAGE_HISTORY_RETENTION_MS } from '../../shared/constants';
import type { AccountPatch, PermissionDecision, Project, Thread } from '../../shared/types';
import {
  assertReq,
  isBoolean,
  isFiniteNumber,
  isNonEmptyString,
  isNullableString,
  isOptionalString,
  isPermissionDecision,
  isPlainObject,
  isString,
  isStringArray,
  isUiPermissionMode,
} from './guards';

/** The slice of `Electron.IpcMainInvokeEvent` the sender check reads. */
export interface IpcEventLike {
  senderFrame?: { url?: string } | null;
}

/** Mirrors `Electron.IpcMain.handle`/`removeHandler` — the only seam this module needs. */
export interface IpcMainLike {
  handle(channel: string, listener: (event: IpcEventLike, req: unknown) => unknown | Promise<unknown>): void;
  removeHandler?(channel: string): void;
}

export class UntrustedSenderError extends Error {
  constructor(channel: string, url: string | undefined) {
    super(`IPC ${channel} refused from untrusted sender: ${url ?? '<unknown>'}`);
    this.name = 'UntrustedSenderError';
  }
}

export interface RegisterIpcServices {
  store: Store;
  threadLog: ThreadLog;
  sessionManager: SessionManager;
  accountPool: AccountPool;
  usagePoller: UsagePoller;
  usageHistory: UsageHistory;
  ptyManager: PtyManager;
  worktreeManager: WorktreeManager;
  dialogs: Dialogs;
  broadcaster: Broadcaster;
  /** `app.getVersion()`, injected so this file never imports `electron` at runtime. */
  appVersion: string;
  /** Sender frame URL check (appUrl.isAppUrl); every invoke from another origin is refused (M1). */
  isTrustedSender: (url: string | undefined) => boolean;
  /** Copies a transcript between account config dirs (account removal hands threads to another account). */
  syncTranscript: SyncTranscriptFn;
}

type Handlers = { [K in InvokeChannel]: (req: unknown) => Promise<InvokeResponse<K>> };

/** A new thread never starts in bypassPermissions (that mode needs the confirmed switch). */
function safeInitialMode(mode: Thread['permissionMode']): Thread['permissionMode'] {
  return mode === 'bypassPermissions' ? 'default' : mode;
}

function buildHandlers(s: RegisterIpcServices): Handlers {
  const {
    store,
    threadLog,
    sessionManager,
    accountPool,
    usagePoller,
    usageHistory,
    ptyManager,
    worktreeManager,
    dialogs,
    broadcaster,
  } = s;

  function requireThread(channel: string, threadId: unknown): Thread {
    assertReq(channel, isNonEmptyString(threadId), 'threadId must be a non-empty string');
    const thread = store.getThread(threadId);
    assertReq(channel, !!thread, `thread not found: ${String(threadId)}`);
    return thread as Thread;
  }

  function requireProject(channel: string, projectId: unknown): Project {
    assertReq(channel, isNonEmptyString(projectId), 'projectId must be a non-empty string');
    const project = store.get().projects.find((p) => p.id === projectId);
    assertReq(channel, !!project, `project not found: ${String(projectId)}`);
    return project as Project;
  }

  return {
    'app:bootstrap': async () => {
      const state = store.get();
      return {
        projects: state.projects,
        threads: state.threads,
        accounts: accountPool.list(),
        pool: usagePoller.getSnapshot(),
        settings: state.settings,
        appVersion: s.appVersion,
        pendingPermissions: sessionManager.pendingPermissions(),
      };
    },

    'project:add': async () => {
      const path = await dialogs.pickProjectFolder();
      if (!path) return null;
      const existing = store.get().projects.find((p) => p.path === path);
      if (existing) return existing;
      const choice = await dialogs.confirmTrustProject(path);
      if (choice === 'cancel') return null;
      const project: Project = {
        id: randomUUID(),
        name: basename(path) || path,
        path,
        trusted: choice === 'trust',
        createdAt: Date.now(),
      };
      store.update((draft) => {
        draft.projects.push(project);
      });
      return project;
    },

    'project:setTrusted': async (req) => {
      assertReq(
        'project:setTrusted',
        isPlainObject(req) && isNonEmptyString(req.projectId) && isBoolean(req.trusted),
        'projectId/trusted required',
      );
      const { trusted } = req as { projectId: string; trusted: boolean };
      const project = requireProject('project:setTrusted', (req as { projectId: string }).projectId);
      if (trusted === project.trusted) return { ...project };
      // Granting trust is confirmed natively (the renderer cannot grant it on its own).
      if (trusted && (await dialogs.confirmTrustProject(project.path)) !== 'trust') return { ...project };
      let updated: Project = project;
      store.update((draft) => {
        const p = draft.projects.find((x) => x.id === project.id);
        if (p) {
          p.trusted = trusted;
          updated = { ...p };
        }
      });
      // Running Queries pick the new settingSources up when their next turn reopens them.
      return updated;
    },

    'project:remove': async (req) => {
      assertReq('project:remove', isPlainObject(req) && isNonEmptyString(req.projectId), 'projectId required');
      const { projectId } = req as { projectId: string };
      const project = store.get().projects.find((p) => p.id === projectId);
      if (!project) return;

      const threads = store.get().threads.filter((t) => t.projectId === projectId);
      for (const thread of threads) {
        await sessionManager.closeThread(thread.id).catch((err: unknown) => console.error('[ipc] closeThread failed', err));
        ptyManager.kill(thread.id);
        await threadLog.remove(thread.id).catch((err: unknown) => console.error('[ipc] threadLog.remove failed', err));
        if (thread.worktree) {
          await worktreeManager
            .remove(project.path, thread.worktree, { force: true })
            .catch((err: unknown) => console.error('[ipc] worktree remove failed', err));
        }
      }

      store.update((draft) => {
        draft.projects = draft.projects.filter((p) => p.id !== projectId);
        draft.threads = draft.threads.filter((t) => t.projectId !== projectId);
      });
    },

    'thread:create': async (req) => {
      assertReq('thread:create', isPlainObject(req) && isNonEmptyString(req.projectId), 'projectId required');
      const { projectId, title, model, permissionMode } = req as {
        projectId: string;
        title?: string;
        model?: string;
        permissionMode?: string;
      };
      assertReq('thread:create', isOptionalString(title), 'title must be a string');
      assertReq('thread:create', isOptionalString(model), 'model must be a string');
      assertReq(
        'thread:create',
        permissionMode === undefined || isUiPermissionMode(permissionMode),
        'invalid permissionMode',
      );
      const project = requireProject('thread:create', projectId);

      const id = randomUUID();
      const shortId = id.slice(0, 8);
      const { cwd, worktree } = await worktreeManager.create(project.path, shortId, { trusted: project.trusted });
      const settings = store.get().settings;
      const now = Date.now();
      const thread: Thread = {
        id,
        projectId,
        title: title ?? 'New thread',
        cwd,
        ...(worktree ? { worktree } : {}),
        model: model ?? settings.defaultModel,
        resolvedModel: null,
        permissionMode: safeInitialMode(
          (permissionMode as Thread['permissionMode'] | undefined) ?? settings.defaultPermissionMode,
        ),
        pinnedAccountId: null,
        lastAccountId: null,
        activeAccountId: null,
        sdkSessionId: null,
        status: 'idle',
        waitingUntil: null,
        pendingPrompt: null,
        sessionStartedAt: null,
        ctxPercent: null,
        createdAt: now,
        updatedAt: now,
      };
      store.update((draft) => {
        draft.threads.push(thread);
      });
      broadcaster.emit('thread:updated', thread);
      return thread;
    },

    'thread:rename': async (req) => {
      assertReq(
        'thread:rename',
        isPlainObject(req) && isNonEmptyString(req.threadId) && isNonEmptyString(req.title),
        'threadId/title required',
      );
      const { threadId, title } = req as { threadId: string; title: string };
      requireThread('thread:rename', threadId);
      const patched = store.patchThread(threadId, { title });
      broadcaster.emit('thread:updated', patched);
    },

    'thread:delete': async (req) => {
      assertReq(
        'thread:delete',
        isPlainObject(req) &&
          isNonEmptyString(req.threadId) &&
          isBoolean(req.removeWorktree) &&
          (req.force === undefined || isBoolean(req.force)),
        'threadId/removeWorktree required',
      );
      const { threadId, removeWorktree, force } = req as { threadId: string; removeWorktree: boolean; force?: boolean };
      const thread = store.getThread(threadId);
      if (!thread) return { ok: true };

      const project = store.get().projects.find((p) => p.id === thread.projectId);
      const worktree = removeWorktree && project ? thread.worktree : undefined;
      // Uncommitted work is never discarded silently: the renderer confirms and retries with force (L10).
      if (worktree && force !== true && (await worktreeManager.isDirty(worktree.path))) {
        return { ok: false, reason: 'worktree-dirty' };
      }

      await sessionManager.closeThread(threadId).catch((err: unknown) => console.error('[ipc] closeThread failed', err));
      ptyManager.kill(threadId);
      await threadLog.remove(threadId).catch((err: unknown) => console.error('[ipc] threadLog.remove failed', err));
      if (worktree && project) {
        await worktreeManager
          .remove(project.path, worktree, { force: force === true })
          .catch((err: unknown) => console.error('[ipc] worktree remove failed', err));
      }
      store.update((draft) => {
        draft.threads = draft.threads.filter((t) => t.id !== threadId);
      });
      return { ok: true };
    },

    'thread:setModel': async (req) => {
      assertReq(
        'thread:setModel',
        isPlainObject(req) && isNonEmptyString(req.threadId) && isNonEmptyString(req.model),
        'threadId/model required',
      );
      const { threadId, model } = req as { threadId: string; model: string };
      requireThread('thread:setModel', threadId);
      await sessionManager.setModel(threadId, model);
    },

    'thread:setPermissionMode': async (req) => {
      assertReq(
        'thread:setPermissionMode',
        isPlainObject(req) && isNonEmptyString(req.threadId) && isUiPermissionMode(req.mode),
        'threadId/mode required',
      );
      const { threadId, mode } = req as { threadId: string; mode: Thread['permissionMode'] };
      const thread = requireThread('thread:setPermissionMode', threadId);
      // bypassPermissions is only entered through a native warning in main (Cancel is the default).
      const confirmed =
        mode !== 'bypassPermissions' || thread.permissionMode === mode || (await dialogs.confirmBypassPermissions());
      if (confirmed) await sessionManager.setPermissionMode(threadId, mode);
      // The renderer does not apply the mode optimistically: always report the applied value.
      const current = store.getThread(threadId);
      if (current) broadcaster.emit('thread:updated', { ...current });
    },

    'thread:pinAccount': async (req) => {
      assertReq(
        'thread:pinAccount',
        isPlainObject(req) && isNonEmptyString(req.threadId) && isNullableString(req.accountId),
        'threadId/accountId required',
      );
      const { threadId, accountId } = req as { threadId: string; accountId: string | null };
      requireThread('thread:pinAccount', threadId);
      const patched = store.patchThread(threadId, { pinnedAccountId: accountId });
      broadcaster.emit('thread:updated', patched);
    },

    'chat:history': async (req) => {
      assertReq('chat:history', isPlainObject(req), 'threadId required');
      const thread = requireThread('chat:history', (req as { threadId?: unknown }).threadId);
      return threadLog.read(thread.id);
    },

    'chat:send': async (req) => {
      assertReq(
        'chat:send',
        isPlainObject(req) && isNonEmptyString(req.threadId) && isNonEmptyString(req.text),
        'threadId/text required',
      );
      const { threadId, text } = req as { threadId: string; text: string };
      return sessionManager.send(threadId, text);
    },

    'chat:interrupt': async (req) => {
      assertReq('chat:interrupt', isPlainObject(req) && isNonEmptyString(req.threadId), 'threadId required');
      await sessionManager.interrupt((req as { threadId: string }).threadId);
    },

    'permission:respond': async (req) => {
      assertReq(
        'permission:respond',
        isPlainObject(req) && isNonEmptyString(req.requestId) && isPermissionDecision(req.decision),
        'requestId/decision required',
      );
      const { requestId, decision, message } = req as {
        requestId: string;
        decision: PermissionDecision;
        message?: string;
      };
      assertReq('permission:respond', isOptionalString(message), 'message must be a string');
      sessionManager.respondPermission(requestId, decision, message);
    },

    'models:list': async () => sessionManager.listModels(),

    'account:loginStart': async (req) => {
      assertReq(
        'account:loginStart',
        isPlainObject(req) && isNonEmptyString(req.alias) && isNonEmptyString(req.color),
        'alias/color required',
      );
      const { alias, color } = req as { alias: string; color: string };
      return accountPool.startLogin({ alias, color });
    },

    'account:loginInput': async (req) => {
      assertReq(
        'account:loginInput',
        isPlainObject(req) && isNonEmptyString(req.loginId) && isString(req.data),
        'loginId/data required',
      );
      const { loginId, data } = req as { loginId: string; data: string };
      accountPool.loginInput(loginId, data);
    },

    'account:loginCancel': async (req) => {
      assertReq('account:loginCancel', isPlainObject(req) && isNonEmptyString(req.loginId), 'loginId required');
      await accountPool.cancelLogin((req as { loginId: string }).loginId);
    },

    'account:update': async (req) => {
      assertReq(
        'account:update',
        isPlainObject(req) && isNonEmptyString(req.accountId) && isPlainObject(req.patch),
        'accountId/patch required',
      );
      const { accountId, patch } = req as { accountId: string; patch: Record<string, unknown> };
      assertReq('account:update', patch.alias === undefined || isString(patch.alias), 'patch.alias must be a string');
      assertReq('account:update', patch.color === undefined || isString(patch.color), 'patch.color must be a string');
      assertReq(
        'account:update',
        patch.enabled === undefined || isBoolean(patch.enabled),
        'patch.enabled must be a boolean',
      );
      return accountPool.update(accountId, patch as AccountPatch);
    },

    'account:reorder': async (req) => {
      assertReq('account:reorder', isPlainObject(req) && isStringArray(req.orderedIds), 'orderedIds required');
      accountPool.reorder((req as { orderedIds: string[] }).orderedIds);
    },

    'account:remove': async (req) => {
      assertReq(
        'account:remove',
        isPlainObject(req) && isNonEmptyString(req.accountId) && isBoolean(req.deleteConfigDir),
        'accountId/deleteConfigDir required',
      );
      const { accountId, deleteConfigDir } = req as { accountId: string; deleteConfigDir: boolean };
      const account = accountPool.get(accountId);
      if (!account) return { ok: true };

      // Threads whose freshest transcript lives in this account are handed to another enabled account.
      const dependents = store.get().threads.filter((t) => t.lastAccountId === accountId);
      const heir = accountPool.list().find((a) => a.id !== accountId && a.enabled);
      if (dependents.length > 0 && !heir) {
        return {
          ok: false,
          error: `${account.alias} holds the conversation history of ${dependents.length} thread(s). Add or enable another account before removing it.`,
        };
      }

      // Disable first so no new turn picks it, then (a) stop its Queries (CLI exit awaited).
      const wasEnabled = account.enabled;
      if (wasEnabled) accountPool.update(accountId, { enabled: false });
      await sessionManager.closeAccount(accountId);

      // (b) copy transcripts to the heir and move lastAccountId. A failed copy aborts the removal: deleting the
      // account (and its config dir) would lose that thread's history.
      for (const thread of store.get().threads) {
        const patch: Partial<Thread> = {};
        if (thread.lastAccountId === accountId && heir) {
          if (thread.sdkSessionId) {
            try {
              await s.syncTranscript(thread.sdkSessionId, account.configDir, heir.configDir);
            } catch (err) {
              console.error('[ipc] transcript handoff failed', err);
              if (wasEnabled) accountPool.update(accountId, { enabled: true });
              return {
                ok: false,
                error: `Could not move the conversation history of "${thread.title}" to ${heir.alias}: ${err instanceof Error ? err.message : String(err)}. ${account.alias} was not removed.`,
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
        return { ok: false, error: `Failed to remove ${account.alias}: ${err instanceof Error ? err.message : String(err)}` };
      }
      return { ok: true };
    },

    'usage:refresh': async (req) => {
      const accountId = isPlainObject(req) && isString(req.accountId) ? req.accountId : undefined;
      return usagePoller.refresh(accountId);
    },

    'usage:history': async (req) => {
      assertReq(
        'usage:history',
        isPlainObject(req) && isNonEmptyString(req.accountId) && isFiniteNumber(req.rangeMs),
        'accountId/rangeMs required',
      );
      const { accountId, rangeMs } = req as { accountId: string; rangeMs: number };
      assertReq('usage:history', !!accountPool.get(accountId), `account not found: ${accountId}`);
      assertReq('usage:history', rangeMs > 0, 'rangeMs must be positive');
      return usageHistory.read(accountId, Math.min(rangeMs, USAGE_HISTORY_RETENTION_MS));
    },

    'pty:open': async (req) => {
      assertReq(
        'pty:open',
        isPlainObject(req) && isNonEmptyString(req.threadId) && isFiniteNumber(req.cols) && isFiniteNumber(req.rows),
        'threadId/cols/rows required',
      );
      const { threadId, cols, rows } = req as { threadId: string; cols: number; rows: number };
      const thread = requireThread('pty:open', threadId);
      return ptyManager.open(threadId, thread.cwd, cols, rows);
    },

    'pty:write': async (req) => {
      assertReq(
        'pty:write',
        isPlainObject(req) && isNonEmptyString(req.threadId) && isString(req.data),
        'threadId/data required',
      );
      const { threadId, data } = req as { threadId: string; data: string };
      ptyManager.write(threadId, data);
    },

    'pty:resize': async (req) => {
      assertReq(
        'pty:resize',
        isPlainObject(req) && isNonEmptyString(req.threadId) && isFiniteNumber(req.cols) && isFiniteNumber(req.rows),
        'threadId/cols/rows required',
      );
      const { threadId, cols, rows } = req as { threadId: string; cols: number; rows: number };
      ptyManager.resize(threadId, cols, rows);
    },
  };
}

/**
 * Registers every plan-3.3 invoke channel as an `ipcMain.handle`, and forwards `AccountPool` /
 * `UsagePoller` change streams onto the broadcaster as `account:updated` / `usage:updated`.
 * Only channels in `INVOKE_CHANNELS` are ever registered — an out-of-allowlist channel simply
 * gets no handler, so Electron rejects it with "No handler registered" on its own.
 * Returns an `Unsubscribe` that tears both down (used by tests and app shutdown).
 */
export function registerIpc(ipcMain: IpcMainLike, services: RegisterIpcServices): Unsubscribe {
  const handlers = buildHandlers(services) as unknown as Record<string, (req: unknown) => Promise<unknown>>;

  for (const channel of INVOKE_CHANNELS) {
    ipcMain.handle(channel, (event, req) => {
      const url = event?.senderFrame?.url;
      if (!services.isTrustedSender(url)) throw new UntrustedSenderError(channel, url);
      return handlers[channel](req);
    });
  }

  const unsubAccounts = services.accountPool.onChange((accounts) => services.broadcaster.emit('account:updated', accounts));
  const unsubUsage = services.usagePoller.onUpdate((snapshot) => services.broadcaster.emit('usage:updated', snapshot));

  return () => {
    unsubAccounts();
    unsubUsage();
    for (const channel of INVOKE_CHANNELS) ipcMain.removeHandler?.(channel);
  };
}
