// Thread -> AgentRunner registry (plan 2.2 / 4.2 session/sessionManager.ts). Claude threads run a ThreadRunner (SDK
// `query`, injected so unit tests and fixture mode pass src/main/fixtures/fakeQuery); Codex / Hermes threads run an
// AcpRunner with the launcher of their agent (bundled codex-acp / `hermes acp`, or the fixture agent).
import { fallbackModels } from '../../shared/constants';
import type { Account, AgentKind, ModelOption } from '../../shared/types';
import { toModelOption, type ModelCatalog } from '../models/modelCatalog';
import type { AcpAgentKind } from '../../core/acpTypes';
import type { AcpConnection, AcpConnectionOptions } from '../acp/acpConnection';
import type {
  AcpLauncher,
  AgentRunner,
  Broadcaster,
  ClaudeBinary,
  QueryFn,
  SessionManager,
  ShellEnv,
  Store,
  ThreadLog,
  UsagePoller,
} from '../contracts';
import { snapshotChangedImages, type ImageSnapshot } from '../images/imageFiles';
import { AcpRunner, type AcpRunnerTimeouts } from './acpRunner';
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
  /** App version for CLAUDE_AGENT_SDK_CLIENT_APP (`deltax/<version>`). */
  appVersion: string;
  syncTranscript?: SyncTranscriptFn;
  /** SDK init `claude_code_version` (usage User-Agent). */
  onCliVersion?: (version: string) => void;
  /** Persisted model list (startup probe); live supportedModels() results are written back to it. */
  models?: Pick<ModelCatalog, 'get' | 'update'>;
  now?: () => number;
  log?: (message: string, err?: unknown) => void;
  waitTickMs?: number;
  /** Turn-end image galleries (default: `git status` of the thread folder). */
  scanImages?: (cwd: string) => Promise<ImageSnapshot | null>;
  /** Codex / Hermes process launchers (absent = the agent counts as not installed). */
  acpLaunchers?: Partial<Record<AcpAgentKind, AcpLauncher>>;
  /** paths.scratchDir(): GIT_CEILING_DIRECTORIES of project-less ACP threads. */
  scratchRoot?: string;
  /** An ACP agent could not start or reported missing auth (LocalAuthService recheck). */
  onAgentProblem?: (agent: AcpAgentKind) => void;
  /** An ACP turn ended (agent usage refresh). */
  onAcpTurnEnd?: (agent: AcpAgentKind) => void;
  /** Tests: ACP connection factory / timeouts. */
  acpConnect?: (opts: AcpConnectionOptions) => AcpConnection;
  acpTimeouts?: Partial<AcpRunnerTimeouts>;
}

const NOT_INSTALLED: AcpLauncher = { resolve: () => ({ ok: false, reason: 'not-installed' }) };

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
  const runners = new Map<string, AgentRunner>();
  /** Runners of deleted threads still waiting for their CLI to exit (abortAll must reach them too). */
  const retiring = new Set<AgentRunner>();
  const broker = createPermissionBroker({
    broadcaster: deps.broadcaster,
    onModeChange: (threadId, mode) => runners.get(threadId)?.applySessionPermissionMode(mode),
  });
  let cachedModels: ModelOption[] | null = null;

  const acpRunner = (agent: AcpAgentKind) => (threadId: string) =>
    new AcpRunner(threadId, {
      agent,
      launcher: deps.acpLaunchers?.[agent] ?? NOT_INSTALLED,
      store: deps.store,
      threadLog: deps.threadLog,
      broadcaster: deps.broadcaster,
      broker,
      appVersion: deps.appVersion,
      ...(deps.scratchRoot !== undefined ? { scratchRoot: deps.scratchRoot } : {}),
      onAgentProblem: deps.onAgentProblem,
      onTurnEnd: deps.onAcpTurnEnd,
      ...(deps.acpConnect ? { connect: deps.acpConnect } : {}),
      ...(deps.acpTimeouts ? { timeouts: deps.acpTimeouts } : {}),
      now,
      log,
    });

  /** Runner per agent kind: the one branch point for new agents (shared/agents.ts, plan 2.2). */
  const runnerFactories: Record<AgentKind, (threadId: string) => AgentRunner> = {
    'claude-code': (threadId) =>
      new ThreadRunner(threadId, {
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
        onSessionInit: refreshModelsOnce,
        // The ceiling only stops searches from inside the scratch root (a scratch chat never scans a repo above it).
        scanImages:
          deps.scanImages ??
          ((cwd) =>
            snapshotChangedImages(cwd, deps.shellEnv.childEnv(deps.scratchRoot !== undefined ? { gitCeiling: deps.scratchRoot } : {}))),
        ...(deps.scratchRoot !== undefined ? { scratchDir: () => deps.scratchRoot as string } : {}),
        now,
        log,
      }),
    codex: acpRunner('codex'),
    hermes: acpRunner('hermes'),
  };

  /** The first live session of this run refreshes the persisted model list (broadcast as models:updated). */
  let modelsRefreshed = false;
  function refreshModelsOnce(): void {
    if (modelsRefreshed || !deps.models) return;
    modelsRefreshed = true;
    void listModels().catch((err: unknown) => log('[session] model refresh failed', err));
  }

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

  function runner(threadId: string): AgentRunner {
    let r = runners.get(threadId);
    if (!r) {
      const thread = deps.store.getThread(threadId);
      if (!thread) throw new Error(`thread not found: ${threadId}`);
      const create = runnerFactories[thread.agent ?? 'claude-code'];
      if (!create) throw new Error(`unsupported agent: ${String(thread.agent)}`);
      r = create(threadId);
      runners.set(threadId, r);
    }
    return r;
  }

  async function listModels(): Promise<ModelOption[]> {
    for (const r of runners.values()) {
      const pending = r.supportedModels();
      if (!pending) continue;
      try {
        const models = await pending;
        cachedModels = models.map(toModelOption);
        if (cachedModels.length > 0) {
          await deps.models?.update(cachedModels).catch((err: unknown) => log('[session] model cache update failed', err));
        }
        break;
      } catch (err) {
        log('[session] supportedModels failed', err);
      }
    }
    // Live session > persisted catalog (startup probe / an earlier session) > built-in fallback.
    return cachedModels ?? deps.models?.get() ?? fallbackModels();
  }

  return {
    broker,
    scheduler,

    send(threadId, text, images, files) {
      return runner(threadId).send(text, images, files);
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
    setAgentMode(threadId, modeId) {
      return runner(threadId).setAgentMode(modeId);
    },
    setAgentConfig(threadId, configId, value) {
      return runner(threadId).setAgentConfig(configId, value);
    },
    respondPermission(requestId, decision, message) {
      broker.respond(requestId, decision, message);
    },

    listModels,

    supportedCommands(threadId) {
      return runners.get(threadId)?.supportedCommands?.() ?? null;
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
      await Promise.all([...runners.values()].map((r) => r.close({ dispose: true })));
      runners.clear();
    },
  };
}
