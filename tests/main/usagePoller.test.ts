import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CredentialsResult, UsageFetchResult } from '../../src/main/contracts';
import { createUsageClient, buildUserAgent } from '../../src/main/usage/usageClient';
import { createUsagePoller, rateLimitBackoffMs } from '../../src/main/usage/usagePoller';
import type { EventChannel, EventPayload } from '../../src/shared/ipc';
import type { Account, PoolSnapshot, UsageSample } from '../../src/shared/types';

const T0 = Date.parse('2026-09-25T12:00:00.000Z');
const MIN = 60_000;

const account = (id: string, over: Partial<Account> = {}): Account => ({
  id,
  alias: id,
  color: '#007AFF',
  email: null,
  plan: 'max',
  configDir: `/acc/${id}`,
  priority: 0,
  enabled: true,
  createdAt: 1,
  ...over,
});

const okBody = (five: number, week = 10) => ({
  five_hour: { utilization: five, resets_at: '2026-09-25T15:00:00.000Z' },
  seven_day: { utilization: week, resets_at: '2026-09-30T00:00:00.000Z' },
  extra_usage: { is_enabled: false },
});

function setup(opts: { accounts?: Account[]; creds?: (dir: string) => CredentialsResult } = {}) {
  let accounts = opts.accounts ?? [account('a')];
  const fetchQueue: UsageFetchResult[] = [];
  const client = {
    fetchUsage: vi.fn(async (_token: string, _ver: string): Promise<UsageFetchResult> => {
      return fetchQueue.shift() ?? { status: 'ok', data: okBody(10) };
    }),
  };
  const credentials = {
    read: vi.fn(async (dir: string): Promise<CredentialsResult> =>
      opts.creds
        ? opts.creds(dir)
        : { status: 'ok', accessToken: `tok-${dir}`, expiresAt: null, subscriptionType: 'max', rateLimitTier: null },
    ),
    invalidate: vi.fn(),
  };
  const samples: { id: string; s: UsageSample }[] = [];
  const history = { append: vi.fn(async (id: string, s: UsageSample) => (samples.push({ id, s }), true)) };
  const broadcasts: PoolSnapshot[] = [];
  const broadcaster = {
    emit<K extends EventChannel>(ch: K, payload: EventPayload<K>) {
      if (ch === 'usage:updated') broadcasts.push(payload as PoolSnapshot);
    },
  };
  let watchCb: (() => void) | null = null;
  const poller = createUsagePoller({
    listAccounts: () => accounts,
    credentials,
    client,
    cliVersion: () => '2.1.282',
    history,
    broadcaster,
    watchAccounts: (cb) => ((watchCb = cb), () => (watchCb = null)),
    random: () => 0.5, // zero jitter
  });
  return {
    poller,
    client,
    credentials,
    history,
    samples,
    broadcasts,
    fetchQueue,
    setAccounts(next: Account[]) {
      accounts = next;
      watchCb?.();
    },
  };
}

describe('usagePoller', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('polls immediately then every 90s, records history and broadcasts changes', async () => {
    const t = setup();
    t.fetchQueue.push({ status: 'ok', data: okBody(10) }, { status: 'ok', data: okBody(20) });
    t.poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.client.fetchUsage).toHaveBeenCalledTimes(1);
    expect(t.client.fetchUsage).toHaveBeenCalledWith('tok-/acc/a', '2.1.282');
    expect(t.poller.getUsage('a')).toMatchObject({
      fiveHour: { percent: 10 },
      sevenDay: { percent: 10 },
      stale: false,
      fetchedAt: T0,
      extraUsageEnabled: false,
    });
    expect(t.broadcasts).toHaveLength(1);
    expect(t.broadcasts[0]!.usageById.a!.fiveHour!.percent).toBe(10);
    expect(t.samples[0]).toEqual({ id: 'a', s: { at: T0, fiveHour: 10, sevenDay: 10, fable: null } });

    await vi.advanceTimersByTimeAsync(89_000);
    expect(t.client.fetchUsage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(t.client.fetchUsage).toHaveBeenCalledTimes(2);
    expect(t.poller.getUsage('a')!.fiveHour!.percent).toBe(20);
    expect(t.broadcasts).toHaveLength(2);

    // unchanged data -> no broadcast
    await vi.advanceTimersByTimeAsync(90_000);
    expect(t.client.fetchUsage).toHaveBeenCalledTimes(3);
    t.poller.stop();
  });

  it('429 -> exponential backoff capped at 5 minutes, reset after success', async () => {
    expect(rateLimitBackoffMs(90_000, 1)).toBe(90_000);
    expect(rateLimitBackoffMs(90_000, 2)).toBe(180_000);
    expect(rateLimitBackoffMs(90_000, 3)).toBe(300_000);
    expect(rateLimitBackoffMs(90_000, 9)).toBe(300_000);

    const t = setup();
    const rl: UsageFetchResult = { status: 'rate_limited', retryAfterMs: null };
    t.fetchQueue.push({ status: 'ok', data: okBody(10) }, rl, rl, rl, rl, rl);
    t.poller.start();
    await vi.advanceTimersByTimeAsync(0); // ok
    await vi.advanceTimersByTimeAsync(90_000); // 429 #1 -> next in 90s
    expect(t.client.fetchUsage).toHaveBeenCalledTimes(2);
    expect(t.poller.getUsage('a')).toMatchObject({ error: 'rate_limited', stale: false, fiveHour: { percent: 10 } });
    await vi.advanceTimersByTimeAsync(90_000); // 429 #2 -> next in 180s
    expect(t.client.fetchUsage).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(179_000);
    expect(t.client.fetchUsage).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1_000); // 429 #3 -> next in 300s
    expect(t.client.fetchUsage).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(299_000);
    expect(t.client.fetchUsage).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1_000); // 429 #4 at 11min -> still 300s cap
    expect(t.client.fetchUsage).toHaveBeenCalledTimes(5);
    expect(t.poller.getUsage('a')).toMatchObject({ error: 'rate_limited', stale: false });
    await vi.advanceTimersByTimeAsync(300_000); // 429 #5 at 16min: data > 15 min old -> stale
    expect(t.client.fetchUsage).toHaveBeenCalledTimes(6);
    expect(t.poller.getUsage('a')).toMatchObject({ error: 'rate_limited', stale: true });
    await vi.advanceTimersByTimeAsync(300_000); // ok -> resets
    expect(t.client.fetchUsage).toHaveBeenCalledTimes(7);
    expect(t.poller.getUsage('a')).toMatchObject({ stale: false });
    expect(t.poller.getUsage('a')!.error).toBeUndefined();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(t.client.fetchUsage).toHaveBeenCalledTimes(8);
    t.poller.stop();
  });

  it('network error -> 2 minute backoff', async () => {
    const t = setup();
    t.fetchQueue.push({ status: 'network', message: 'ECONNRESET' });
    t.poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.poller.getUsage('a')).toMatchObject({ error: 'network', stale: true });
    await vi.advanceTimersByTimeAsync(119_000);
    expect(t.client.fetchUsage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(t.client.fetchUsage).toHaveBeenCalledTimes(2);
    t.poller.stop();
  });

  it('token_expired -> skips fetch and marks stale, keeps last data, recovers later', async () => {
    let expired = false;
    const t = setup({
      creds: () =>
        expired
          ? { status: 'token_expired', expiresAt: T0 }
          : { status: 'ok', accessToken: 'tok', expiresAt: null, subscriptionType: null, rateLimitTier: null },
    });
    t.poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.client.fetchUsage).toHaveBeenCalledTimes(1);
    expired = true;
    await vi.advanceTimersByTimeAsync(90_000);
    expect(t.client.fetchUsage).toHaveBeenCalledTimes(1);
    expect(t.poller.getUsage('a')).toMatchObject({ error: 'token_expired', stale: true, fiveHour: { percent: 10 } });
    expired = false;
    await vi.advanceTimersByTimeAsync(90_000);
    expect(t.client.fetchUsage).toHaveBeenCalledTimes(2);
    expect(t.poller.getUsage('a')).toMatchObject({ stale: false });
    t.poller.stop();
  });

  it('no_credentials / auth (403) -> error state, auth invalidates cached credentials', async () => {
    const t = setup({
      accounts: [account('a'), account('b', { configDir: '/acc/b' })],
      creds: (dir) =>
        dir === '/acc/a'
          ? { status: 'no_credentials' }
          : { status: 'ok', accessToken: 'tb', expiresAt: null, subscriptionType: null, rateLimitTier: null },
    });
    t.fetchQueue.push({ status: 'auth' });
    await t.poller.refresh();
    expect(t.poller.getUsage('a')).toMatchObject({ error: 'no_credentials', stale: true });
    expect(t.poller.getUsage('b')).toMatchObject({ error: 'auth', stale: true });
    expect(t.credentials.invalidate).toHaveBeenCalledWith('/acc/b');
  });

  it('detects extra_usage enabled', async () => {
    const t = setup();
    t.fetchQueue.push({ status: 'ok', data: { ...okBody(5), extra_usage: { is_enabled: true, monthly_limit: 5000 } } });
    await t.poller.refresh('a');
    expect(t.poller.getUsage('a')!.extraUsageEnabled).toBe(true);
  });

  it('reportRateLimit applies immediately; overage -> rejectedUntil.overage; survives the next poll', async () => {
    const t = setup();
    await t.poller.refresh();
    const n = t.broadcasts.length;
    const until = T0 + 60 * MIN;
    t.poller.reportRateLimit('a', { status: 'allowed', isUsingOverage: true, resetsAt: Math.floor(until / 1000) });
    expect(t.poller.getUsage('a')!.rejectedUntil).toEqual({ overage: until });
    expect(t.broadcasts).toHaveLength(n + 1);
    expect(t.broadcasts.at(-1)!.summary.available).toBe(0);

    t.poller.reportRateLimit('a', { status: 'rejected', rateLimitType: 'five_hour' });
    expect(t.poller.getUsage('a')!.rejectedUntil!.fiveHour).toBe(T0 + 5 * MIN);

    await t.poller.refresh('a');
    expect(t.poller.getUsage('a')!.rejectedUntil).toEqual({ overage: until, fiveHour: T0 + 5 * MIN });
    // expired blocks are dropped on the next successful poll
    vi.setSystemTime(until + 1);
    await t.poller.refresh('a');
    expect(t.poller.getUsage('a')!.rejectedUntil).toBeUndefined();
  });

  it('markAuthFailed sets auth error and invalidates credentials', async () => {
    const t = setup();
    await t.poller.refresh();
    t.poller.markAuthFailed('a');
    expect(t.poller.getUsage('a')).toMatchObject({ error: 'auth', stale: true });
    expect(t.credentials.invalidate).toHaveBeenCalledWith('/acc/a');
  });

  it('(review 4) an auth error survives network / rate_limited polls and is cleared only by an ok poll', async () => {
    const t = setup();
    await t.poller.refresh();
    t.poller.markAuthFailed('a');
    t.fetchQueue.push({ status: 'network', message: 'offline' });
    await t.poller.refresh('a');
    expect(t.poller.getUsage('a')).toMatchObject({ error: 'auth' });
    t.fetchQueue.push({ status: 'rate_limited', retryAfterMs: null });
    await t.poller.refresh('a');
    expect(t.poller.getUsage('a')).toMatchObject({ error: 'auth' });
    t.fetchQueue.push({ status: 'ok', data: okBody(10) });
    await t.poller.refresh('a');
    expect(t.poller.getUsage('a')!.error).toBeUndefined();
  });

  it('refresh returns a snapshot with summary and notifies onUpdate', async () => {
    const t = setup({ accounts: [account('a'), account('b', { configDir: '/acc/b', priority: 1 })] });
    t.fetchQueue.push({ status: 'ok', data: okBody(100) }, { status: 'ok', data: okBody(40) });
    const seen: PoolSnapshot[] = [];
    t.poller.onUpdate((s) => seen.push(s));
    const snap = await t.poller.refresh();
    expect(snap.summary.total).toBe(2);
    expect(snap.summary.avg.fiveHour).toBe(70);
    expect(snap.summary.available).toBe(1);
    expect(seen).toHaveLength(1);
    expect(t.poller.getSnapshot().usageById).toEqual(snap.usageById);
  });

  it('adds timers for new accounts and drops disabled / removed ones', async () => {
    const t = setup();
    t.poller.start();
    await vi.advanceTimersByTimeAsync(0);
    t.setAccounts([account('a'), account('b', { configDir: '/acc/b' })]);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.poller.getUsage('b')).toBeDefined();
    t.setAccounts([account('a', { enabled: false }), account('b', { configDir: '/acc/b' })]);
    expect(t.poller.getUsage('a')).toBeUndefined();
    const calls = t.client.fetchUsage.mock.calls.length;
    await vi.advanceTimersByTimeAsync(90_000);
    expect(t.client.fetchUsage.mock.calls.length).toBe(calls + 1); // only b
    t.poller.stop();
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(t.client.fetchUsage.mock.calls.length).toBe(calls + 1);
  });

  it('(L4) a fetch that completes after the account was removed records nothing', async () => {
    const t = setup();
    let release!: (r: UsageFetchResult) => void;
    t.client.fetchUsage.mockImplementationOnce(() => new Promise<UsageFetchResult>((r) => (release = r)));
    const refreshing = t.poller.refresh('a');
    await vi.advanceTimersByTimeAsync(0);
    t.setAccounts([]);
    release({ status: 'ok', data: okBody(55) });
    await refreshing;
    expect(t.poller.getUsage('a')).toBeUndefined();
    expect(t.samples).toEqual([]);
  });
});

describe('usageClient', () => {
  const okResponse = () => new Response(JSON.stringify(okBody(1)), { status: 200 });

  it('sends the documented headers with a versioned User-Agent', async () => {
    const fetchFn = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => okResponse());
    const client = createUsageClient({ fetch: fetchFn as unknown as typeof fetch });
    const r = await client.fetchUsage('TOKEN', '2.1.282');
    expect(r).toEqual({ status: 'ok', data: okBody(1) });
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe('https://api.anthropic.com/api/oauth/usage');
    expect(init!.method).toBe('GET');
    expect(init!.headers).toEqual({
      Authorization: 'Bearer TOKEN',
      'anthropic-beta': 'oauth-2025-04-20',
      'Content-Type': 'application/json',
      'User-Agent': 'claude-code/2.1.282',
    });
    expect(init!.signal).toBeInstanceOf(AbortSignal);
  });

  it('omits an invented User-Agent', async () => {
    expect(buildUserAgent('')).toBeUndefined();
    expect(buildUserAgent('2.1.282\r\nX: y')).toBeUndefined();
    expect(buildUserAgent(' 2.1.282-beta.1 ')).toBe('claude-code/2.1.282-beta.1');
    const fetchFn = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => okResponse());
    await createUsageClient({ fetch: fetchFn as unknown as typeof fetch }).fetchUsage('T', 'garbage');
    expect((fetchFn.mock.calls[0]![1]!.headers as Record<string, string>)['User-Agent']).toBeUndefined();
  });

  it('maps statuses: 429 (retry-after), 401/403 auth, 5xx / thrown / bad JSON network', async () => {
    const mk = (res: Response | Error) =>
      createUsageClient({
        fetch: (async () => {
          if (res instanceof Error) throw res;
          return res;
        }) as unknown as typeof fetch,
      });
    expect(await mk(new Response('', { status: 429, headers: { 'retry-after': '348' } })).fetchUsage('t', '1.0.0')).toEqual({
      status: 'rate_limited',
      retryAfterMs: 348_000,
    });
    expect(await mk(new Response('', { status: 429 })).fetchUsage('t', '1.0.0')).toEqual({
      status: 'rate_limited',
      retryAfterMs: null,
    });
    expect(await mk(new Response('', { status: 403 })).fetchUsage('t', '1.0.0')).toEqual({ status: 'auth' });
    expect(await mk(new Response('', { status: 401 })).fetchUsage('t', '1.0.0')).toEqual({ status: 'auth' });
    expect(await mk(new Response('', { status: 500 })).fetchUsage('t', '1.0.0')).toEqual({
      status: 'network',
      message: 'HTTP 500',
    });
    expect(await mk(new Error('timeout')).fetchUsage('t', '1.0.0')).toEqual({ status: 'network', message: 'timeout' });
    expect((await mk(new Response('{bad', { status: 200 })).fetchUsage('t', '1.0.0')).status).toBe('network');
  });
});
