// In-memory implementations of the session dependencies (Store / ThreadLog / UsagePoller / Broadcaster)
// for 2A unit tests and lightweight fixture wiring. No filesystem or network access.
import { buildChildEnv } from '../../core/childEnv';
import { summarizePool } from '../../core/poolSummary';
import { applyRateLimitEvent } from '../../core/usageParse';
import { DEFAULT_SETTINGS } from '../../shared/constants';
import type { EventChannel, EventPayload } from '../../shared/ipc';
import type {
  Account,
  AccountUsage,
  ChatItem,
  PersistedState,
  PoolSnapshot,
  RateLimitInfoLite,
  Thread,
} from '../../shared/types';
import type { Broadcaster, ClaudeBinary, ShellEnv, Store, ThreadLog, UsagePoller } from '../contracts';

export function makeAccount(id: string, over: Partial<Account> = {}): Account {
  return {
    id,
    alias: id,
    color: '#007AFF',
    email: `${id}@example.com`,
    plan: 'max',
    configDir: `/accounts/${id}`,
    priority: 0,
    enabled: true,
    createdAt: 0,
    ...over,
  };
}

export function makeThread(id: string, over: Partial<Thread> = {}): Thread {
  return {
    id,
    projectId: 'project-1',
    agent: 'claude-code',
    title: id,
    cwd: '/work/project',
    model: 'default',
    resolvedModel: null,
    permissionMode: 'default',
    effort: null,
    pinnedAccountId: null,
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
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

export function createMemoryStore(initial: Partial<PersistedState> = {}): Store {
  const state: PersistedState = {
    version: 1,
    projects: [],
    threads: [],
    accounts: [],
    ...initial,
    settings: { ...DEFAULT_SETTINGS, ...(initial.settings ?? {}) },
  };
  const listeners = new Set<(s: PersistedState) => void>();
  const notify = () => listeners.forEach((cb) => cb(state));
  return {
    async load() {
      return state;
    },
    get: () => state,
    update(mutator) {
      mutator(state);
      notify();
    },
    getThread: (threadId) => state.threads.find((t) => t.id === threadId),
    patchThread(threadId, patch) {
      const thread = state.threads.find((t) => t.id === threadId);
      if (!thread) throw new Error(`thread not found: ${threadId}`);
      Object.assign(thread, patch, { updatedAt: Date.now() });
      notify();
      return thread;
    },
    async flush() {},
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}

export interface MemoryThreadLog extends ThreadLog {
  items: Map<string, ChatItem[]>;
}

export function createMemoryThreadLog(): MemoryThreadLog {
  const items = new Map<string, ChatItem[]>();
  return {
    items,
    async append(threadId, item) {
      const list = items.get(threadId) ?? [];
      const idx = list.findIndex((i) => i.id === item.id);
      if (idx >= 0) list[idx] = item;
      else list.push(item);
      items.set(threadId, list);
    },
    async read(threadId) {
      return [...(items.get(threadId) ?? [])];
    },
    async remove(threadId) {
      items.delete(threadId);
    },
  };
}

export interface MemoryUsagePoller extends UsagePoller {
  usageById: Record<string, AccountUsage>;
  set(accountId: string, usage: AccountUsage): void;
  reports: { accountId: string; info: RateLimitInfoLite }[];
  refreshCount: number;
}

/** Usage store that applies SDK rate-limit events with core/usageParse and summarizes with core/poolSummary. */
export function createMemoryUsagePoller(listAccounts: () => Account[], now: () => number = Date.now): MemoryUsagePoller {
  const usageById: Record<string, AccountUsage> = {};
  const listeners = new Set<(s: PoolSnapshot) => void>();
  const snapshot = (): PoolSnapshot => ({
    summary: summarizePool(listAccounts(), usageById, now()),
    usageById: { ...usageById },
    at: now(),
  });
  const notify = () => {
    const s = snapshot();
    listeners.forEach((cb) => cb(s));
  };
  const poller: MemoryUsagePoller = {
    usageById,
    reports: [],
    refreshCount: 0,
    set(accountId, usage) {
      usageById[accountId] = usage;
      notify();
    },
    start() {},
    stop() {},
    async refresh() {
      poller.refreshCount += 1;
      notify();
      return snapshot();
    },
    reportRateLimit(accountId, info) {
      poller.reports.push({ accountId, info });
      usageById[accountId] = applyRateLimitEvent(usageById[accountId], info, now());
      notify();
    },
    markAuthFailed(accountId) {
      usageById[accountId] = { ...(usageById[accountId] ?? { fetchedAt: now(), stale: false }), error: 'auth' };
      notify();
    },
    getSnapshot: snapshot,
    getUsage: (accountId) => usageById[accountId],
    onUpdate(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
  return poller;
}

export interface RecordedEvent {
  channel: EventChannel;
  payload: unknown;
}

export interface RecordingBroadcaster extends Broadcaster {
  events: RecordedEvent[];
  of<K extends EventChannel>(channel: K): EventPayload<K>[];
}

export function createRecordingBroadcaster(): RecordingBroadcaster {
  const events: RecordedEvent[] = [];
  return {
    events,
    emit(channel, payload) {
      events.push({ channel, payload });
    },
    of(channel) {
      return events.filter((e) => e.channel === channel).map((e) => e.payload) as never;
    },
  };
}

/** ShellEnv over a fixed base env (still routed through core/childEnv.buildChildEnv). */
export function createStaticShellEnv(base: Record<string, string> = { PATH: '/usr/bin:/bin', HOME: '/home/fixture' }): ShellEnv {
  return {
    async init() {},
    baseEnv: () => ({ ...base }),
    childEnv: (inject) => buildChildEnv(base, inject),
  };
}

export function createStaticClaudeBinary(path = '/fixture/bin/claude'): ClaudeBinary {
  return { resolvePath: () => path, getCliVersion: () => '2.1.282' };
}
