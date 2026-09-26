// Wires the plan 3.3 invoke contract to injected services (plan 4.2 `ipc/register.ts`).
// `IpcMainLike` mirrors the slice of `Electron.IpcMain` this module needs, so registerIpc can be
// exercised in plain Node tests with a fake — no Electron runtime import here.
// Service *construction and wiring* (DI) happens in Wave 3 (src/main/index.ts); this module only
// maps each invoke channel onto the service methods it's given, validating input and
// performing the small bits of orchestration (project/thread CRUD, pin) that no single Wave 1/2
// service owns.
import { randomUUID } from 'node:crypto';
import { realpath, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { INVOKE_CHANNELS, type InvokeChannel, type InvokeResponse } from '../../shared/ipc';
import type {
  AccountPool,
  Broadcaster,
  Dialogs,
  EditorLauncher,
  GitService,
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
import { NAV_CHANNELS, buildNavHandlers, type NavChannel, type NavHandlers, type NavServices } from './navHandlers';
import { imageHandlers, isChatImageList, type ImageActions } from './imageHandlers';
import { DEFAULT_THREAD_TITLE, DRAFT_PTY_SESSION_ID, USAGE_HISTORY_RETENTION_MS } from '../../shared/constants';
import { AGENTS, DEFAULT_AGENT, isAgentKind } from '../../shared/agents';
import { isStrictlyInside } from '../containment';
import { markdownFileName, threadToMarkdown } from '../../core/threadMarkdown';
import { deriveThreadTitle } from '../../core/threadTitle';
import { isSafeBranchName } from '../../core/ghPrs';
import { applySettingsPatch, isEditorId, validateSettingsPatch } from '../../core/settings';
import type {
  AccountPatch,
  AgentKind,
  AppInfo,
  AppSettings,
  ChatSendResult,
  EffortLevel,
  PermissionDecision,
  Project,
  SharedConfigStatus,
  Thread,
  ThreadStartRequest,
  ThreadStartResult,
} from '../../shared/types';
import {
  assertReq,
  isBoolean,
  isEffortLevel,
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
  gitService: GitService;
  editorLauncher: EditorLauncher;
  /** App / CLI / SDK versions and the data folder. */
  appInfo: () => AppInfo;
  /** Reveals the (fixed) app data folder; a no-op in headless e2e. */
  openDataFolder: () => Promise<void>;
  quit: () => void;
  /** ~/.claude sharing state per account, and re-linking every account. */
  sharedConfig: { status(): Promise<SharedConfigStatus>; relink(): Promise<SharedConfigStatus> };
  /** Called after `settings:update` stored a change (main re-applies poll interval etc.). */
  onSettingsChanged?: (next: AppSettings, prev: AppSettings) => void;
  /** Fixture / headless e2e run (bootstrap `testMode`: no system notifications). */
  testMode?: boolean;
  /** ⌘K thread search, 풀 리퀘스트, 예약, 플러그인 (navHandlers.ts). */
  nav?: NavServices;
  /** Receives the `thread:start` handler so main-side callers (예약) start threads the way a draft does. */
  provideThreadStart?: (start: (req: ThreadStartRequest) => Promise<ThreadStartResult>) => void;
  /** Lightbox "Finder에서 보기" / "복사" (Electron shell + clipboard). */
  images?: ImageActions;
}

const NO_IMAGE_ACTIONS: ImageActions = {
  reveal() {
    throw new Error('image actions unavailable');
  },
  copy() {
    throw new Error('image actions unavailable');
  },
};

type Handlers = { [K in InvokeChannel]: (req: unknown) => Promise<InvokeResponse<K>> };

/** A new thread never starts in bypassPermissions (that mode needs the confirmed switch). */
function safeInitialMode(mode: Thread['permissionMode']): Thread['permissionMode'] {
  return mode === 'bypassPermissions' ? 'default' : mode;
}

/** `@`-mention for a picked file: relative to `base` when inside it, quoted when it contains whitespace. */
export function mentionPath(file: string, base: string): string {
  const rel = relative(base, file);
  const inside = rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
  const path = inside ? rel : file;
  return /\s/.test(path) ? `@"${path}"` : `@${path}`;
}

function buildHandlers(s: RegisterIpcServices): Omit<Handlers, NavChannel> {
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

  /**
   * A `pty:*` session id is either a real thread id or the reserved draft id (no thread yet, ⌘J from the
   * "new chat" screen) -- anything else is refused (H1: only `pty:open` used to validate this; `pty:write` /
   * `pty:resize` now do too).
   */
  function requirePtySessionId(channel: string, threadId: unknown): string {
    assertReq(channel, isNonEmptyString(threadId), 'threadId must be a non-empty string');
    if (threadId === DRAFT_PTY_SESSION_ID) return threadId;
    requireThread(channel, threadId);
    return threadId;
  }

  /**
   * cwd for a `pty:open`: the thread's own cwd, or -- for the draft session -- the given project's folder
   * (only a project the store actually knows about; the renderer never hands main a raw path) falling back to
   * the user's home folder.
   */
  function resolvePtyCwd(channel: string, threadId: string, projectId: string | undefined): string {
    if (threadId !== DRAFT_PTY_SESSION_ID) return requireThread(channel, threadId).cwd;
    const project = projectId !== undefined ? store.get().projects.find((p) => p.id === projectId) : undefined;
    return project?.path ?? homedir();
  }

  /**
   * New idle thread in `project`: its own git worktree when the setting allows it and the folder is a repo,
   * otherwise the project folder itself. Not stored or broadcast.
   */
  async function createThreadRecord(
    project: Project,
    opts: {
      title: string;
      agent?: AgentKind;
      model?: string;
      permissionMode: Thread['permissionMode'];
      effort?: EffortLevel | null;
      pinnedAccountId?: string | null;
      /** PR head to start from; always gets its own worktree (the project's checkout is never switched). */
      base?: { branch: string; pr?: number };
    },
  ): Promise<Thread> {
    const id = randomUUID();
    const shortId = id.slice(0, 8);
    const settings = store.get().settings;
    const { cwd, worktree } =
      settings.useWorktree || opts.base
        ? await worktreeManager.create(project.path, shortId, { trusted: project.trusted, ...(opts.base ? { base: opts.base } : {}) })
        : { cwd: project.path, worktree: undefined };
    const now = Date.now();
    return {
      id,
      projectId: project.id,
      agent: opts.agent ?? DEFAULT_AGENT,
      title: opts.title,
      cwd,
      ...(worktree ? { worktree } : {}),
      model: opts.model ?? settings.defaultModel,
      resolvedModel: null,
      permissionMode: opts.permissionMode,
      effort: opts.effort === undefined ? settings.defaultEffort : opts.effort,
      pinnedAccountId: opts.pinnedAccountId ?? null,
      pinned: false,
      archived: false,
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
  }

  /** Closes the runner and pty, removes the history, the worktree (when asked) and the thread record. */
  async function deleteThread(thread: Thread, removeWorktree: boolean, force: boolean): Promise<void> {
    const project = store.get().projects.find((p) => p.id === thread.projectId);
    const worktree = removeWorktree && project ? thread.worktree : undefined;
    await sessionManager.closeThread(thread.id).catch((err: unknown) => console.error('[ipc] closeThread failed', err));
    ptyManager.kill(thread.id);
    await threadLog.remove(thread.id).catch((err: unknown) => console.error('[ipc] threadLog.remove failed', err));
    if (worktree && project) {
      await worktreeManager
        .remove(project.path, worktree, { force })
        .catch((err: unknown) => console.error('[ipc] worktree remove failed', err));
    }
    store.update((draft) => {
      draft.threads = draft.threads.filter((t) => t.id !== thread.id);
    });
  }

  /** Thread plus its project folder (git operations run in `thread.cwd`, based on the project's branch). */
  function requireThreadFolder(channel: string, req: unknown): { thread: Thread; projectPath: string } {
    assertReq(channel, isPlainObject(req), 'threadId required');
    const thread = requireThread(channel, (req as { threadId?: unknown }).threadId);
    const project = store.get().projects.find((p) => p.id === thread.projectId);
    return { thread, projectPath: project?.path ?? thread.cwd };
  }

  /** Repo-relative path from the renderer: non-empty, relative, no NUL; GitService re-checks containment. */
  function requireRelPath(channel: string, path: unknown): string {
    assertReq(
      channel,
      isNonEmptyString(path) && path.length <= 4096 && !path.includes('\0') && !isAbsolute(path),
      'path must be a relative path',
    );
    return path as string;
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
        homeDir: homedir(),
        pendingPermissions: sessionManager.pendingPermissions(),
        testMode: s.testMode === true,
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
      const thread = await createThreadRecord(project, {
        title: title ?? DEFAULT_THREAD_TITLE,
        model,
        permissionMode: safeInitialMode(
          (permissionMode as Thread['permissionMode'] | undefined) ?? store.get().settings.defaultPermissionMode,
        ),
      });
      store.update((draft) => {
        draft.threads.push(thread);
      });
      broadcaster.emit('thread:updated', thread);
      return thread;
    },

    'thread:start': async (req) => {
      const channel = 'thread:start';
      assertReq(channel, isPlainObject(req), 'request object required');
      const r = req as Record<string, unknown>;
      assertReq(channel, isNonEmptyString(r.projectId), 'projectId required');
      assertReq(channel, isNonEmptyString(r.text) && r.text.trim().length > 0, 'text required');
      assertReq(channel, isOptionalString(r.model), 'model must be a string');
      assertReq(channel, r.permissionMode === undefined || isUiPermissionMode(r.permissionMode), 'invalid permissionMode');
      assertReq(channel, r.effort === undefined || r.effort === null || isEffortLevel(r.effort), 'invalid effort');
      assertReq(channel, r.agent === undefined || isAgentKind(r.agent), 'invalid agent');
      assertReq(
        channel,
        r.pinnedAccountId === undefined || isNullableString(r.pinnedAccountId),
        'pinnedAccountId must be a string or null',
      );
      assertReq(channel, r.baseBranch === undefined || (isNonEmptyString(r.baseBranch) && isSafeBranchName(r.baseBranch)), 'invalid baseBranch');
      assertReq(
        channel,
        r.basePr === undefined || (r.baseBranch !== undefined && isFiniteNumber(r.basePr) && Number.isInteger(r.basePr) && r.basePr > 0),
        'invalid basePr',
      );
      const project = requireProject(channel, r.projectId);
      const text = r.text as string;
      const pinnedAccountId = (r.pinnedAccountId as string | null | undefined) ?? null;
      assertReq(channel, pinnedAccountId === null || !!accountPool.get(pinnedAccountId), `account not found: ${pinnedAccountId}`);

      // A draft may ask for bypassPermissions; it is only granted through the same native warning.
      let mode = (r.permissionMode as Thread['permissionMode'] | undefined) ?? store.get().settings.defaultPermissionMode;
      if (mode === 'bypassPermissions' && !(await dialogs.confirmBypassPermissions())) mode = 'default';

      const thread = await createThreadRecord(project, {
        title: deriveThreadTitle(text),
        agent: r.agent as AgentKind | undefined,
        model: r.model as string | undefined,
        permissionMode: mode,
        effort: (r.effort as EffortLevel | null | undefined) ?? null,
        pinnedAccountId,
        ...(r.baseBranch !== undefined
          ? { base: { branch: r.baseBranch as string, ...(r.basePr !== undefined ? { pr: r.basePr as number } : {}) } }
          : {}),
      });
      store.update((draft) => {
        draft.threads.push(thread);
      });

      // Not broadcast yet: a refused first send rolls everything back, so the renderer never sees the thread.
      const rollback = async () => {
        await sessionManager.closeThread(thread.id).catch((err: unknown) => console.error('[ipc] closeThread failed', err));
        await threadLog.remove(thread.id).catch((err: unknown) => console.error('[ipc] threadLog.remove failed', err));
        if (thread.worktree) {
          await worktreeManager
            .remove(project.path, thread.worktree, { force: true })
            .catch((err: unknown) => console.error('[ipc] worktree remove failed', err));
        }
        store.update((draft) => {
          draft.threads = draft.threads.filter((t) => t.id !== thread.id);
        });
      };

      let send: ChatSendResult;
      try {
        send = await sessionManager.send(thread.id, text);
      } catch (err) {
        await rollback();
        throw err;
      }
      if (!send.accepted) {
        await rollback();
        return { ok: false, reason: send.reason ?? 'no-accounts' };
      }
      const current = { ...(store.getThread(thread.id) ?? thread) };
      broadcaster.emit('thread:updated', current);
      return { ok: true, thread: current, send };
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

    'thread:setPinned': async (req) => {
      assertReq(
        'thread:setPinned',
        isPlainObject(req) && isNonEmptyString(req.threadId) && isBoolean(req.pinned),
        'threadId/pinned required',
      );
      const { threadId, pinned } = req as { threadId: string; pinned: boolean };
      requireThread('thread:setPinned', threadId);
      broadcaster.emit('thread:updated', { ...store.patchThread(threadId, { pinned }) });
    },

    'thread:setArchived': async (req) => {
      assertReq(
        'thread:setArchived',
        isPlainObject(req) && isNonEmptyString(req.threadId) && isBoolean(req.archived),
        'threadId/archived required',
      );
      const { threadId, archived } = req as { threadId: string; archived: boolean };
      requireThread('thread:setArchived', threadId);
      // An archived thread leaves the pinned section too; unarchiving does not re-pin it.
      const patch: Partial<Thread> = archived ? { archived, pinned: false } : { archived };
      broadcaster.emit('thread:updated', { ...store.patchThread(threadId, patch) });
    },

    'thread:setEffort': async (req) => {
      assertReq(
        'thread:setEffort',
        isPlainObject(req) && isNonEmptyString(req.threadId) && (req.effort === null || isEffortLevel(req.effort)),
        'threadId/effort required',
      );
      const { threadId, effort } = req as { threadId: string; effort: EffortLevel | null };
      requireThread('thread:setEffort', threadId);
      await sessionManager.setEffort(threadId, effort);
      const current = store.getThread(threadId);
      if (current) broadcaster.emit('thread:updated', { ...current });
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
      await deleteThread(thread, removeWorktree, force === true);
      return { ok: true };
    },

    'threads:deleteArchived': async () => {
      // The renderer confirmed "모두 삭제" (worktrees go too, uncommitted changes included).
      const archived = store.get().threads.filter((t) => t.archived);
      for (const thread of archived) await deleteThread(thread, true, true);
      return { deleted: archived.length };
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
      const images = (req as { images?: unknown }).images;
      assertReq('chat:send', images === undefined || isChatImageList(images), 'invalid images');
      const { threadId, text } = req as { threadId: string; text: string };
      return images && images.length > 0 ? sessionManager.send(threadId, text, images) : sessionManager.send(threadId, text);
    },

    ...imageHandlers(requireThread, s.images ?? NO_IMAGE_ACTIONS),

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

    'dialog:pickFiles': async (req) => {
      assertReq(
        'dialog:pickFiles',
        isPlainObject(req) && isOptionalString(req.threadId) && isOptionalString(req.projectId),
        'threadId/projectId must be strings',
      );
      const { threadId, projectId } = req as { threadId?: string; projectId?: string };
      assertReq('dialog:pickFiles', !!threadId || !!projectId, 'threadId or projectId required');
      const base = threadId ? requireThread('dialog:pickFiles', threadId).cwd : requireProject('dialog:pickFiles', projectId).path;
      const files = await dialogs.pickFiles(base);
      return files.filter((f) => typeof f === 'string' && isAbsolute(f)).map((f) => mentionPath(f, base));
    },

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
          error: `${account.alias} 계정에 스레드 ${dependents.length}개의 대화 기록이 있습니다. 다른 계정을 추가하거나 활성화한 뒤 제거하세요.`,
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
      const { threadId, cols, rows, projectId } = req as {
        threadId: string;
        cols: number;
        rows: number;
        projectId?: unknown;
      };
      assertReq('pty:open', projectId === undefined || isNonEmptyString(projectId), 'projectId must be a string');
      requirePtySessionId('pty:open', threadId);
      const cwd = resolvePtyCwd('pty:open', threadId, projectId as string | undefined);
      return ptyManager.open(threadId, cwd, cols, rows);
    },

    'pty:restart': async (req) => {
      assertReq(
        'pty:restart',
        isPlainObject(req) && isNonEmptyString(req.threadId) && isFiniteNumber(req.cols) && isFiniteNumber(req.rows),
        'threadId/cols/rows required',
      );
      const { threadId, cols, rows, projectId } = req as {
        threadId: string;
        cols: number;
        rows: number;
        projectId?: unknown;
      };
      assertReq('pty:restart', projectId === undefined || isNonEmptyString(projectId), 'projectId must be a string');
      requirePtySessionId('pty:restart', threadId);
      const cwd = resolvePtyCwd('pty:restart', threadId, projectId as string | undefined);
      // kill + open back to back: the old process's exit arrives later and is ignored (the id maps to the new shell).
      ptyManager.kill(threadId);
      const { ptyId } = ptyManager.open(threadId, cwd, cols, rows);
      return { ptyId };
    },

    'pty:write': async (req) => {
      assertReq(
        'pty:write',
        isPlainObject(req) && isNonEmptyString(req.threadId) && isString(req.data),
        'threadId/data required',
      );
      const { threadId, data } = req as { threadId: string; data: string };
      requirePtySessionId('pty:write', threadId);
      ptyManager.write(threadId, data);
    },

    'settings:update': async (req) => {
      const checked = validateSettingsPatch(req);
      assertReq('settings:update', checked.ok, checked.ok ? '' : checked.error);
      const patch = (checked as { ok: true; patch: Parameters<typeof applySettingsPatch>[1] }).patch;
      const prev = store.get().settings;
      const next = applySettingsPatch(prev, patch);
      store.update((draft) => {
        draft.settings = next;
      });
      s.onSettingsChanged?.(next, prev);
      broadcaster.emit('settings:updated', next);
      return next;
    },

    'app:info': async () => s.appInfo(),

    'app:openDataFolder': async () => {
      await s.openDataFolder();
    },

    'app:quit': async () => {
      s.quit();
    },

    'config:sharedStatus': async () => s.sharedConfig.status(),

    'config:relink': async () => s.sharedConfig.relink(),

    'editor:list': async () => s.editorLauncher.list(),

    'editor:open': async (req) => {
      assertReq('editor:open', isPlainObject(req) && isEditorId(req.editor), 'threadId/editor required');
      const { thread } = requireThreadFolder('editor:open', req);
      const editor = (req as { editor: Parameters<EditorLauncher['open']>[0] }).editor;
      const rawPath = (req as { path?: unknown }).path;
      // Only the thread's own folder (or a file inside it) is ever handed to another app.
      if (rawPath === undefined) return s.editorLauncher.open(editor, thread.cwd);
      const path = requireRelPath('editor:open', rawPath);
      const target = resolve(thread.cwd, path);
      assertReq('editor:open', isStrictlyInside(thread.cwd, target), 'path outside the thread folder');
      // Symlinks must not lead out of the folder either.
      const [realRoot, realTarget] = await Promise.all([realpath(thread.cwd), realpath(target).catch(() => null)]);
      assertReq('editor:open', realTarget !== null && isStrictlyInside(realRoot, realTarget), 'file not found in the thread folder');
      await s.editorLauncher.open(editor, editor === 'finder' ? dirname(realTarget as string) : (realTarget as string));
    },

    'git:changes': async (req) => {
      const { thread, projectPath } = requireThreadFolder('git:changes', req);
      return s.gitService.changes(thread.cwd, projectPath);
    },

    'git:fileDiff': async (req) => {
      const { thread, projectPath } = requireThreadFolder('git:fileDiff', req);
      const path = requireRelPath('git:fileDiff', (req as { path?: unknown }).path);
      return s.gitService.fileDiff(thread.cwd, projectPath, path);
    },

    'git:revertFile': async (req) => {
      const { thread } = requireThreadFolder('git:revertFile', req);
      const path = requireRelPath('git:revertFile', (req as { path?: unknown }).path);
      return s.gitService.revertFile(thread.cwd, path);
    },

    'git:commit': async (req) => {
      const { thread } = requireThreadFolder('git:commit', req);
      const message = (req as { message?: unknown }).message;
      assertReq('git:commit', isString(message) && message.length <= 10_000, 'message must be a string');
      return s.gitService.commit(thread.cwd, message as string);
    },

    'git:merge': async (req) => {
      const { thread, projectPath } = requireThreadFolder('git:merge', req);
      if (!thread.worktree) return { ok: false, error: 'worktree 스레드가 아닙니다' };
      return s.gitService.merge(thread.cwd, projectPath);
    },

    'git:remoteInfo': async (req) => {
      const { thread, projectPath } = requireThreadFolder('git:remoteInfo', req);
      return s.gitService.remoteInfo(thread.cwd, projectPath);
    },

    'git:pushPr': async (req) => {
      const { thread, projectPath } = requireThreadFolder('git:pushPr', req);
      const { title, body } = req as { title?: unknown; body?: unknown };
      assertReq('git:pushPr', isNonEmptyString(title) && title.length <= 300, 'title required');
      assertReq('git:pushPr', isString(body) && body.length <= 20_000, 'body must be a string');
      return s.gitService.pushAndOpenPr(thread.cwd, projectPath, title as string, body as string);
    },

    'git:createBranch': async (req) => {
      const { thread } = requireThreadFolder('git:createBranch', req);
      const name = (req as { name?: unknown }).name;
      assertReq('git:createBranch', isString(name) && name.length <= 256, 'name must be a string');
      // Only a thread's own worktree (created and recorded by main) is ever switched.
      if (!thread.worktree || resolve(thread.cwd) !== resolve(thread.worktree.path)) {
        return { ok: false, error: 'worktree 스레드에서만 브랜치를 만들 수 있습니다' };
      }
      return s.gitService.createBranch(thread.worktree.path, name as string);
    },

    'thread:exportMarkdown': async (req) => {
      assertReq('thread:exportMarkdown', isPlainObject(req), 'threadId required');
      const thread = requireThread('thread:exportMarkdown', (req as { threadId?: unknown }).threadId);
      const project = store.get().projects.find((p) => p.id === thread.projectId);
      const items = await threadLog.read(thread.id);
      const markdown = threadToMarkdown(
        { title: thread.title, project: project?.name ?? null, agentName: AGENTS[thread.agent].name, exportedAt: Date.now() },
        items,
      );
      const path = await dialogs.saveMarkdown(markdownFileName(thread.title));
      if (!path) return { ok: false };
      if (!isAbsolute(path)) return { ok: false, error: '저장 경로가 올바르지 않습니다' };
      try {
        await writeFile(path, markdown, 'utf8');
      } catch (err) {
        return { ok: false, error: `저장하지 못했습니다: ${err instanceof Error ? err.message : String(err)}` };
      }
      return { ok: true, path };
    },

    'pty:resize': async (req) => {
      assertReq(
        'pty:resize',
        isPlainObject(req) && isNonEmptyString(req.threadId) && isFiniteNumber(req.cols) && isFiniteNumber(req.rows),
        'threadId/cols/rows required',
      );
      const { threadId, cols, rows } = req as { threadId: string; cols: number; rows: number };
      requirePtySessionId('pty:resize', threadId);
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
  const core = buildHandlers(services);
  services.provideThreadStart?.(core['thread:start'] as (req: ThreadStartRequest) => Promise<ThreadStartResult>);
  const nav: NavHandlers = services.nav
    ? buildNavHandlers(services.store, services.nav)
    : (Object.fromEntries(
        NAV_CHANNELS.map((ch) => [
          ch,
          async () => {
            throw new Error(`${ch} unavailable`);
          },
        ]),
      ) as unknown as NavHandlers);
  const handlers = { ...core, ...nav } as unknown as Record<string, (req: unknown) => Promise<unknown>>;

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
