// Per-account usage polling (plan 0.2, 4.2).
// 90s + jitter poll; 429 -> min(poll * 2^(n-1), 5min) backoff (OMC usage-api.js getRateLimitedBackoffMs);
// network error -> 2min; data older than 15min is stale; token_expired / no_credentials -> skip fetch, stale.
// SDK rate_limit_event is applied immediately through reportRateLimit.
import { summarizePool } from '../../core/poolSummary';
import { applyRateLimitEvent, parseUsageResponse } from '../../core/usageParse';
import {
  USAGE_NETWORK_BACKOFF_MS,
  USAGE_POLL_INTERVAL_MS,
  USAGE_POLL_JITTER_MS,
  USAGE_RATE_LIMIT_BACKOFF_MAX_MS,
  USAGE_STALE_AFTER_MS,
} from '../../shared/constants';
import type { Account, AccountUsage, PoolSnapshot, RateLimitInfoLite, UsageError } from '../../shared/types';
import type {
  Broadcaster,
  Credentials,
  Unsubscribe,
  UsageClient,
  UsageHistory,
  UsagePoller,
} from '../contracts';

export interface UsagePollerDeps {
  listAccounts: () => Account[];
  credentials: Pick<Credentials, 'read' | 'invalidate'>;
  client: UsageClient;
  /** CLI version for the User-Agent (SDK init claude_code_version or manifest.json). */
  cliVersion: () => string | null;
  history: Pick<UsageHistory, 'append'>;
  broadcaster?: Broadcaster;
  /** Subscribe to account list changes (AccountPool.onChange) to add/drop poll timers. */
  watchAccounts?: (cb: () => void) => Unsubscribe;
  now?: () => number;
  /** 0..1, jitter source. */
  random?: () => number;
  pollIntervalMs?: number;
}

interface PollState {
  timer: ReturnType<typeof setTimeout> | null;
  inflight: Promise<void> | null;
  rateLimitedCount: number;
}

export function rateLimitBackoffMs(pollIntervalMs: number, count: number): number {
  return Math.min(pollIntervalMs * 2 ** Math.max(0, count - 1), USAGE_RATE_LIMIT_BACKOFF_MAX_MS);
}

function pruneRejected(rejected: AccountUsage['rejectedUntil'], now: number): AccountUsage['rejectedUntil'] {
  if (!rejected) return undefined;
  const kept = Object.fromEntries(Object.entries(rejected).filter(([, until]) => until != null && until > now));
  return Object.keys(kept).length ? kept : undefined;
}

export function createUsagePoller(deps: UsagePollerDeps): UsagePoller {
  const now = deps.now ?? Date.now;
  const random = deps.random ?? Math.random;
  const interval = deps.pollIntervalMs ?? USAGE_POLL_INTERVAL_MS;
  const usageById: Record<string, AccountUsage> = {};
  const states = new Map<string, PollState>();
  const listeners = new Set<(s: PoolSnapshot) => void>();
  let running = false;
  let unwatch: Unsubscribe | null = null;

  const enabledAccounts = (): Account[] => deps.listAccounts().filter((a) => a.enabled);

  function snapshot(): PoolSnapshot {
    const t = now();
    return { summary: summarizePool(deps.listAccounts(), { ...usageById }, t), usageById: { ...usageById }, at: t };
  }

  function broadcast(): PoolSnapshot {
    const snap = snapshot();
    deps.broadcaster?.emit('usage:updated', snap);
    for (const cb of listeners) cb(snap);
    return snap;
  }

  function setUsage(accountId: string, next: AccountUsage): boolean {
    const prev = usageById[accountId];
    if (prev && JSON.stringify(prev) === JSON.stringify(next)) return false;
    usageById[accountId] = next;
    const sample = {
      at: now(),
      fiveHour: next.fiveHour?.percent ?? null,
      sevenDay: next.sevenDay?.percent ?? null,
      fable: next.fable?.percent ?? null,
    };
    if (sample.fiveHour !== null || sample.sevenDay !== null || sample.fable !== null) {
      void deps.history.append(accountId, sample).catch(() => {});
    }
    return true;
  }

  function withError(accountId: string, error: UsageError, forceStale: boolean): AccountUsage {
    const prev = usageById[accountId];
    const t = now();
    const fetchedAt = prev?.fetchedAt ?? 0;
    // Only a successful poll proves the credentials work again; a transient failure keeps `auth`.
    const keepAuth = prev?.error === 'auth' && (error === 'network' || error === 'rate_limited');
    return {
      ...(prev ?? { fetchedAt }),
      rejectedUntil: pruneRejected(prev?.rejectedUntil, t),
      error: keepAuth ? 'auth' : error,
      stale: forceStale || !prev || t - fetchedAt > USAGE_STALE_AFTER_MS,
    };
  }

  function state(accountId: string): PollState {
    let s = states.get(accountId);
    if (!s) {
      s = { timer: null, inflight: null, rateLimitedCount: 0 };
      states.set(accountId, s);
    }
    return s;
  }

  /** Still enabled (not disabled / removed while a fetch was in flight). */
  const isActive = (accountId: string): boolean => enabledAccounts().some((a) => a.id === accountId);

  /** Fetch once; returns the delay until the next poll. Results for an account that went away are dropped (L4). */
  async function pollOnce(account: Account): Promise<number> {
    const s = state(account.id);
    const creds = await deps.credentials.read(account.configDir);
    if (!isActive(account.id)) return interval;
    if (creds.status !== 'ok') {
      setUsage(account.id, withError(account.id, creds.status, true));
      return interval;
    }
    const res = await deps.client.fetchUsage(creds.accessToken, deps.cliVersion() ?? '');
    if (!isActive(account.id)) return interval;
    switch (res.status) {
      case 'ok': {
        const parsed = parseUsageResponse(res.data);
        if (!parsed) {
          setUsage(account.id, withError(account.id, 'network', false));
          return USAGE_NETWORK_BACKOFF_MS;
        }
        s.rateLimitedCount = 0;
        const t = now();
        const next: AccountUsage = { ...parsed, fetchedAt: t, stale: false };
        const rejected = pruneRejected(usageById[account.id]?.rejectedUntil, t);
        if (rejected) next.rejectedUntil = rejected;
        setUsage(account.id, next);
        return interval;
      }
      case 'rate_limited': {
        s.rateLimitedCount += 1;
        setUsage(account.id, withError(account.id, 'rate_limited', false));
        const backoff = rateLimitBackoffMs(interval, s.rateLimitedCount);
        return Math.min(Math.max(backoff, res.retryAfterMs ?? 0), USAGE_RATE_LIMIT_BACKOFF_MAX_MS);
      }
      case 'auth':
        deps.credentials.invalidate(account.configDir);
        setUsage(account.id, withError(account.id, 'auth', true));
        return interval;
      case 'network':
        setUsage(account.id, withError(account.id, 'network', false));
        return USAGE_NETWORK_BACKOFF_MS;
    }
  }

  function jittered(delay: number): number {
    return Math.max(0, delay + (random() * 2 - 1) * USAGE_POLL_JITTER_MS);
  }

  function schedule(accountId: string, delay: number): void {
    const s = state(accountId);
    if (s.timer) clearTimeout(s.timer);
    s.timer = setTimeout(() => {
      s.timer = null;
      void runPoll(accountId, true);
    }, delay);
  }

  /** Poll one account (dedup in-flight), broadcast on change, reschedule while running. */
  function runPoll(accountId: string, notify: boolean): Promise<void> {
    const s = state(accountId);
    if (s.inflight) return s.inflight;
    const account = enabledAccounts().find((a) => a.id === accountId);
    if (!account) return Promise.resolve();
    if (s.timer) {
      clearTimeout(s.timer);
      s.timer = null;
    }
    const before = JSON.stringify(usageById[accountId] ?? null);
    s.inflight = pollOnce(account)
      .catch(() => {
        if (isActive(accountId)) setUsage(accountId, withError(accountId, 'network', false));
        return USAGE_NETWORK_BACKOFF_MS;
      })
      .then((delay) => {
        s.inflight = null;
        if (running && enabledAccounts().some((a) => a.id === accountId)) schedule(accountId, jittered(delay));
        if (notify && JSON.stringify(usageById[accountId] ?? null) !== before) broadcast();
      });
    return s.inflight;
  }

  /** Start timers for new enabled accounts; drop timers and data for removed / disabled ones. */
  function reconcile(): void {
    const enabled = new Set(enabledAccounts().map((a) => a.id));
    let dropped = false;
    for (const [id, s] of states) {
      if (enabled.has(id)) continue;
      if (s.timer) clearTimeout(s.timer);
      states.delete(id);
    }
    for (const id of Object.keys(usageById)) {
      if (!enabled.has(id)) {
        delete usageById[id];
        dropped = true;
      }
    }
    if (running) {
      for (const id of enabled) {
        const s = state(id);
        if (!s.timer && !s.inflight) void runPoll(id, true);
      }
    }
    if (dropped) broadcast();
  }

  return {
    start() {
      if (running) return;
      running = true;
      unwatch = deps.watchAccounts?.(reconcile) ?? null;
      reconcile();
    },

    stop() {
      running = false;
      unwatch?.();
      unwatch = null;
      for (const s of states.values()) {
        if (s.timer) clearTimeout(s.timer);
        s.timer = null;
      }
    },

    async refresh(accountId) {
      reconcile();
      const ids = accountId ? [accountId] : enabledAccounts().map((a) => a.id);
      await Promise.all(ids.map((id) => runPoll(id, false)));
      return broadcast();
    },

    reportRateLimit(accountId: string, info: RateLimitInfoLite) {
      if (setUsage(accountId, applyRateLimitEvent(usageById[accountId], info, now()))) broadcast();
    },

    markAuthFailed(accountId: string) {
      const account = deps.listAccounts().find((a) => a.id === accountId);
      if (account) deps.credentials.invalidate(account.configDir);
      if (setUsage(accountId, withError(accountId, 'auth', true))) broadcast();
    },

    getSnapshot: snapshot,

    getUsage: (accountId) => usageById[accountId],

    onUpdate(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
