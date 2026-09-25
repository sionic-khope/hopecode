// Thread -> ThreadRunner registry (plan 4.2 session/sessionManager.ts). The SDK `query` function is
// injected so unit tests and fixture mode pass src/main/fixtures/fakeQuery.
import { FALLBACK_MODELS } from '../../shared/constants';
import type { Account, ModelOption } from '../../shared/types';
import type {
  Broadcaster,
  ClaudeBinary,
  QueryFn,
  SessionManager,
  ShellEnv,
  Store,
  ThreadLog,
  UsagePoller,
} from '../contracts';
import { createPermissionBroker, type PermissionBroker } from './permissionBroker';
import { ThreadRunner } from './threadRunner';
import { syncTranscript as defaultSyncTranscript, type SyncTranscriptFn } from './transcriptSync';
import { createWaitScheduler, type WaitScheduler } from './waitScheduler';

export interface SessionManagerDeps {
  query: QueryFn;
  store: Pick<Store, 'get' | 'getThread' | 'patchThread'>;
  threadLog: Pick<ThreadLog, 'append'>;
  /** AccountPool.list */
  listAccounts: () => Account[];
  usage: Pick<UsagePoller, 'refresh' | 'reportRateLimit' | 'markAuthFailed' | 'getSnapshot'>;
  shellEnv: Pick<ShellEnv, 'childEnv'>;
  claudeBinary: Pick<ClaudeBinary, 'resolvePath'>;
  broadcaster: Broadcaster;
  /** App version for CLAUDE_AGENT_SDK_CLIENT_APP (`hopecode/<version>`). */
  appVersion: string;
  syncTranscript?: SyncTranscriptFn;
  /** SDK init `claude_code_version` (usage User-Agent). */
  onCliVersion?: (version: string) => void;
  now?: () => number;
  log?: (message: string, err?: unknown) => void;
  waitTickMs?: number;
}

export interface SessionManagerImpl extends SessionManager {
  readonly broker: PermissionBroker;
  readonly scheduler: WaitScheduler;
  reevaluate(): Promise<void>;
  /** Resolves when the thread's current turn chain (retries, ctx fetch, idle close) has settled. */
  whenSettled(threadId: string): Promise<void>;
}

export function createSessionManager(deps: SessionManagerDeps): SessionManagerImpl {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((message: string, err?: unknown) => console.error(message, err ?? ''));
  const runners = new Map<string, ThreadRunner>();
  /** Runners of deleted threads still waiting for their CLI to exit (abortAll must reach them too). */
  const retiring = new Set<ThreadRunner>();
  const broker = createPermissionBroker({
    broadcaster: deps.broadcaster,
    onModeChange: (threadId, mode) => runners.get(threadId)?.applySessionPermissionMode(mode),
  });
  let cachedModels: ModelOption[] | null = null;

  const scheduler = createWaitScheduler({
    getWaitingUntil: (threadId) => {
      const thread = deps.store.getThread(threadId);
      return thread?.status === 'waiting' ? (thread.waitingUntil ?? now()) : null;
    },
    evaluate: (threadId, due) => runner(threadId).resumeWaiting(due),
    now,
    tickMs: deps.waitTickMs,
    log,
  });

  function runner(threadId: string): ThreadRunner {
    let r = runners.get(threadId);
    if (!r) {
      if (!deps.store.getThread(threadId)) throw new Error(`thread not found: ${threadId}`);
      r = new ThreadRunner(threadId, {
        query: deps.query,
        store: deps.store,
        threadLog: deps.threadLog,
        listAccounts: deps.listAccounts,
        usage: deps.usage,
        shellEnv: deps.shellEnv,
        claudeBinary: deps.claudeBinary,
        broadcaster: deps.broadcaster,
        broker,
        syncTranscript: deps.syncTranscript ?? defaultSyncTranscript,
        appVersion: deps.appVersion,
        onWaiting: (id, waiting) => (waiting ? scheduler.track(id) : scheduler.untrack(id)),
        onCliVersion: deps.onCliVersion,
        now,
        log,
      });
      runners.set(threadId, r);
    }
    return r;
  }

  return {
    broker,
    scheduler,

    send(threadId, text) {
      return runner(threadId).send(text);
    },
    interrupt(threadId) {
      return runner(threadId).interrupt();
    },
    setModel(threadId, model) {
      return runner(threadId).setModel(model);
    },
    setPermissionMode(threadId, mode) {
      return runner(threadId).setPermissionMode(mode);
    },
    setEffort(threadId, effort) {
      return runner(threadId).setEffort(effort);
    },
    respondPermission(requestId, decision, message) {
      broker.respond(requestId, decision, message);
    },

    async listModels() {
      for (const r of runners.values()) {
        const q = r.query();
        if (!q) continue;
        try {
          const models = await q.supportedModels();
          cachedModels = models.map((m) => ({
            value: m.value,
            label: m.displayName,
            description: m.description,
            ...(m.supportsEffort === false
              ? { effortLevels: [] }
              : m.supportedEffortLevels
                ? { effortLevels: [...m.supportedEffortLevels] }
                : {}),
          }));
          break;
        } catch (err) {
          log('[session] supportedModels failed', err);
        }
      }
      return cachedModels ?? [...FALLBACK_MODELS];
    },

    async closeAccount(accountId) {
      await Promise.all([...runners.values()].map((r) => r.releaseAccount(accountId)));
    },

    pendingPermissions() {
      return broker.pending();
    },

    abortAll() {
      scheduler.stop();
      broker.cancelAll();
      for (const r of [...runners.values(), ...retiring]) r.abort();
    },

    async closeThread(threadId) {
      const r = runners.get(threadId);
      scheduler.untrack(threadId);
      broker.cancelThread(threadId);
      if (!r) return;
      runners.delete(threadId);
      retiring.add(r);
      try {
        await r.close();
      } finally {
        retiring.delete(r);
      }
    },

    restore() {
      for (const thread of deps.store.get().threads) {
        if (thread.status === 'waiting') scheduler.track(thread.id);
      }
      // Threads whose waitingUntil already passed are evaluated immediately.
      void scheduler.reevaluate();
    },

    reevaluate() {
      return scheduler.reevaluate();
    },

    whenSettled(threadId) {
      return runners.get(threadId)?.whenSettled() ?? Promise.resolve();
    },

    async dispose() {
      scheduler.stop();
      broker.cancelAll();
      await Promise.all([...runners.values()].map((r) => r.close()));
      runners.clear();
    },
  };
}
