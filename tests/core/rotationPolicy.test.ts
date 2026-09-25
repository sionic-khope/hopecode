import { describe, expect, it } from 'vitest';
import { effectivePercent, isAccountAvailable, pickAccount } from '../../src/core/rotationPolicy';
import type { Account, AccountUsage, LimitReading, PickAccountInput } from '../../src/shared/types';

const NOW = 1_000_000_000_000;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

function account(overrides: Partial<Account> = {}): Account {
  return {
    id: 'a',
    alias: 'A',
    color: '#007AFF',
    email: 'a@example.com',
    plan: 'max',
    configDir: '/tmp/a',
    priority: 0,
    enabled: true,
    createdAt: NOW,
    ...overrides,
  };
}

function reading(percent: number, resetsAt: number | null = null): LimitReading {
  return { percent, resetsAt };
}

function usage(overrides: Partial<AccountUsage> = {}): AccountUsage {
  return { fetchedAt: NOW, stale: false, ...overrides };
}

describe('effectivePercent', () => {
  it('returns 0 for an undefined reading', () => {
    expect(effectivePercent(undefined, NOW)).toBe(0);
  });

  it('returns 0 when resetsAt has already passed', () => {
    expect(effectivePercent(reading(80, NOW - 1000), NOW)).toBe(0);
  });

  it('returns 0 when resetsAt is exactly now', () => {
    expect(effectivePercent(reading(80, NOW), NOW)).toBe(0);
  });

  it('returns the raw percent when resetsAt is in the future', () => {
    expect(effectivePercent(reading(80, NOW + HOUR_MS), NOW)).toBe(80);
  });

  it('returns the raw percent when resetsAt is null (unknown)', () => {
    expect(effectivePercent(reading(42, null), NOW)).toBe(42);
  });
});

describe('isAccountAvailable', () => {
  it('is available with no usage data at all', () => {
    expect(isAccountAvailable(undefined, NOW)).toBe(true);
  });

  it('is unavailable when fiveHour is at 100 and not yet reset', () => {
    const u = usage({ fiveHour: reading(100, NOW + HOUR_MS) });
    expect(isAccountAvailable(u, NOW)).toBe(false);
  });

  it('is unavailable when sevenDay is at 100', () => {
    const u = usage({ sevenDay: reading(100, NOW + HOUR_MS) });
    expect(isAccountAvailable(u, NOW)).toBe(false);
  });

  it('is available again once fiveHour resetsAt has passed', () => {
    const u = usage({ fiveHour: reading(100, NOW - 1000) });
    expect(isAccountAvailable(u, NOW)).toBe(true);
  });

  it('is unavailable while rejectedUntil.fiveHour is in the future', () => {
    const u = usage({ rejectedUntil: { fiveHour: NOW + MINUTE_MS } });
    expect(isAccountAvailable(u, NOW)).toBe(false);
  });

  it('is unavailable while rejectedUntil.sevenDay is in the future', () => {
    const u = usage({ rejectedUntil: { sevenDay: NOW + MINUTE_MS } });
    expect(isAccountAvailable(u, NOW)).toBe(false);
  });

  it('is unavailable while rejectedUntil.overage is in the future', () => {
    const u = usage({ rejectedUntil: { overage: NOW + MINUTE_MS } });
    expect(isAccountAvailable(u, NOW)).toBe(false);
  });

  it('is available again once rejectedUntil has passed', () => {
    const u = usage({ rejectedUntil: { fiveHour: NOW - 1000 } });
    expect(isAccountAvailable(u, NOW)).toBe(true);
  });

  it('ignores fable exhaustion for a non-fable resolvedModel', () => {
    const u = usage({ fable: reading(100, NOW + HOUR_MS) });
    expect(isAccountAvailable(u, NOW, { resolvedModel: 'claude-sonnet-4-5' })).toBe(true);
  });

  it('ignores rejectedUntil.fable for a non-fable resolvedModel', () => {
    const u = usage({ rejectedUntil: { fable: NOW + HOUR_MS } });
    expect(isAccountAvailable(u, NOW, { resolvedModel: 'claude-sonnet-4-5' })).toBe(true);
  });

  it('requires fable to be available when resolvedModel matches /fable/i', () => {
    const u = usage({ fable: reading(100, NOW + HOUR_MS) });
    expect(isAccountAvailable(u, NOW, { resolvedModel: 'claude-fable-5' })).toBe(false);
  });

  it('requires rejectedUntil.fable to have passed when resolvedModel matches /fable/i', () => {
    const u = usage({ rejectedUntil: { fable: NOW + HOUR_MS } });
    expect(isAccountAvailable(u, NOW, { resolvedModel: 'Fable' })).toBe(false);
  });

  it('is available for a fable model when fable itself is fine', () => {
    const u = usage({ fable: reading(9, NOW + HOUR_MS) });
    expect(isAccountAvailable(u, NOW, { resolvedModel: 'claude-fable-5' })).toBe(true);
  });
});

describe('pickAccount', () => {
  function input(overrides: Partial<PickAccountInput> = {}): PickAccountInput {
    return {
      accounts: [],
      usageById: {},
      pinnedAccountId: null,
      resolvedModel: null,
      now: NOW,
      ...overrides,
    };
  }

  it('returns none when there are no enabled accounts', () => {
    const accounts = [account({ id: 'a', enabled: false })];
    expect(pickAccount(input({ accounts }))).toEqual({ type: 'none' });
  });

  it('picks accounts in ascending priority order', () => {
    const accounts = [
      account({ id: 'b', priority: 2 }),
      account({ id: 'a', priority: 1 }),
      account({ id: 'c', priority: 3 }),
    ];
    expect(pickAccount(input({ accounts }))).toEqual({ type: 'account', accountId: 'a' });
  });

  it('skips disabled accounts', () => {
    const accounts = [account({ id: 'a', priority: 0, enabled: false }), account({ id: 'b', priority: 1 })];
    expect(pickAccount(input({ accounts }))).toEqual({ type: 'account', accountId: 'b' });
  });

  it('prefers an available pinned account over priority order', () => {
    const accounts = [account({ id: 'a', priority: 0 }), account({ id: 'b', priority: 1 })];
    expect(pickAccount(input({ accounts, pinnedAccountId: 'b' }))).toEqual({ type: 'account', accountId: 'b' });
  });

  it('falls back to priority order when the pinned account is disabled', () => {
    const accounts = [account({ id: 'a', priority: 0 }), account({ id: 'b', priority: 1, enabled: false })];
    expect(pickAccount(input({ accounts, pinnedAccountId: 'b' }))).toEqual({ type: 'account', accountId: 'a' });
  });

  it('falls back to priority order when the pinned account is exhausted', () => {
    const accounts = [account({ id: 'a', priority: 0 }), account({ id: 'b', priority: 1 })];
    const usageById = { b: usage({ fiveHour: reading(100, NOW + HOUR_MS) }) };
    expect(pickAccount(input({ accounts, usageById, pinnedAccountId: 'b' }))).toEqual({
      type: 'account',
      accountId: 'a',
    });
  });

  it('excludes a fable-exhausted account only for a fable resolvedModel', () => {
    const accounts = [account({ id: 'a', priority: 0 }), account({ id: 'b', priority: 1 })];
    const usageById = { a: usage({ fable: reading(100, NOW + HOUR_MS) }) };

    expect(pickAccount(input({ accounts, usageById, resolvedModel: 'claude-fable-5' }))).toEqual({
      type: 'account',
      accountId: 'b',
    });
    expect(pickAccount(input({ accounts, usageById, resolvedModel: 'claude-sonnet-4-5' }))).toEqual({
      type: 'account',
      accountId: 'a',
    });
  });

  it('respects rejectedUntil per LimitKind (fable-blocked account is available for sonnet)', () => {
    const accounts = [account({ id: 'a', priority: 0 })];
    const usageById = { a: usage({ rejectedUntil: { fable: NOW + HOUR_MS } }) };

    expect(pickAccount(input({ accounts, usageById, resolvedModel: 'claude-fable-5' }))).toEqual({
      type: 'waiting',
      until: NOW + HOUR_MS,
    });
    expect(pickAccount(input({ accounts, usageById, resolvedModel: 'claude-sonnet-4-5' }))).toEqual({
      type: 'account',
      accountId: 'a',
    });
  });

  it('honors the exclude set', () => {
    const accounts = [account({ id: 'a', priority: 0 }), account({ id: 'b', priority: 1 })];
    expect(pickAccount(input({ accounts, exclude: new Set(['a']) }))).toEqual({ type: 'account', accountId: 'b' });
  });

  it('excludes an account blocked by overage', () => {
    const accounts = [account({ id: 'a', priority: 0 }), account({ id: 'b', priority: 1 })];
    const usageById = { a: usage({ rejectedUntil: { overage: NOW + HOUR_MS } }) };
    expect(pickAccount(input({ accounts, usageById }))).toEqual({ type: 'account', accountId: 'b' });
  });

  it('returns waiting with the min of per-account max-blocking-window when all are exhausted', () => {
    const accounts = [account({ id: 'a', priority: 0 }), account({ id: 'b', priority: 1 })];
    const usageById = {
      a: usage({
        fiveHour: reading(100, NOW + 2 * HOUR_MS),
        rejectedUntil: { overage: NOW + 3 * HOUR_MS },
      }),
      b: usage({ fiveHour: reading(100, NOW + HOUR_MS) }),
    };
    // account a's own max blocking window is 3h; account b's is 1h. Waiting until = min(3h, 1h) = 1h.
    expect(pickAccount(input({ accounts, usageById }))).toEqual({ type: 'waiting', until: NOW + HOUR_MS });
  });

  it('falls back to now+5min when the only blocking reading has a null resetsAt', () => {
    const accounts = [account({ id: 'a', priority: 0 })];
    const usageById = { a: usage({ fiveHour: reading(100, null) }) };
    const result = pickAccount(input({ accounts, usageById }));
    expect(result).toEqual({ type: 'waiting', until: NOW + 5 * MINUTE_MS });
  });

  it('returns none when there are zero enabled accounts even with usage data', () => {
    const accounts = [account({ id: 'a', enabled: false })];
    const usageById = { a: usage({ fiveHour: reading(50, null) }) };
    expect(pickAccount(input({ accounts, usageById }))).toEqual({ type: 'none' });
  });

  it('becomes available again once the blocking time has passed', () => {
    const accounts = [account({ id: 'a', priority: 0 })];
    const usageById = { a: usage({ fiveHour: reading(100, NOW - 1000) }) };
    expect(pickAccount(input({ accounts, usageById }))).toEqual({ type: 'account', accountId: 'a' });
  });
});

describe('(M1) auth-failed accounts', () => {
  it('are unavailable until a successful poll clears the error', () => {
    expect(isAccountAvailable({ fetchedAt: NOW, stale: true, error: 'auth' }, NOW)).toBe(false);
    expect(isAccountAvailable({ fetchedAt: NOW, stale: false }, NOW)).toBe(true);
    // Other errors (network / rate-limited usage endpoint) do not block turns.
    expect(isAccountAvailable({ fetchedAt: NOW, stale: false, error: 'network' }, NOW)).toBe(true);
  });

  it('are skipped by pickAccount', () => {
    const accounts = [account({ id: 'a', priority: 0 }), account({ id: 'b', priority: 1 })];
    const usageById: Record<string, AccountUsage> = { a: { fetchedAt: NOW, stale: true, error: 'auth' } };
    expect(
      pickAccount({ accounts, usageById, pinnedAccountId: null, resolvedModel: null, now: NOW }),
    ).toEqual({ type: 'account', accountId: 'b' });
  });
});

describe('(review 5) every enabled account auth-failed', () => {
  const authFailed: AccountUsage = { fetchedAt: NOW, stale: true, error: 'auth' };

  it('returns none with reason auth instead of an endless wait', () => {
    const accounts = [account({ id: 'a', priority: 0 }), account({ id: 'b', priority: 1 })];
    const usageById = { a: authFailed, b: authFailed };
    expect(
      pickAccount({ accounts, usageById, pinnedAccountId: null, resolvedModel: null, now: NOW }),
    ).toEqual({ type: 'none', reason: 'auth' });
  });

  it('still waits for a rate-limited account while the others are auth-failed (wait time ignores auth ones)', () => {
    const accounts = [account({ id: 'a', priority: 0 }), account({ id: 'b', priority: 1 })];
    const usageById = { a: authFailed, b: usage({ fiveHour: reading(100, NOW + 2 * HOUR_MS) }) };
    expect(
      pickAccount({ accounts, usageById, pinnedAccountId: null, resolvedModel: null, now: NOW }),
    ).toEqual({ type: 'waiting', until: NOW + 2 * HOUR_MS });
  });
});

describe('(review 6) unresolved model falls back to the explicit thread model', () => {
  const accounts = [account({ id: 'a', priority: 0 }), account({ id: 'b', priority: 1 })];
  const usageById = { a: usage({ rejectedUntil: { opus: NOW + HOUR_MS } }) };
  const base = { accounts, usageById, pinnedAccountId: null, resolvedModel: null, now: NOW };

  it('applies the model-scoped limit of thread.model when resolvedModel is null', () => {
    expect(pickAccount({ ...base, model: 'opus' })).toEqual({ type: 'account', accountId: 'b' });
  });

  it("ignores model-scoped limits for the 'default' model as before", () => {
    expect(pickAccount({ ...base, model: 'default' })).toEqual({ type: 'account', accountId: 'a' });
  });

  it('prefers resolvedModel when it is known', () => {
    expect(pickAccount({ ...base, model: 'opus', resolvedModel: 'claude-sonnet-5' })).toEqual({
      type: 'account',
      accountId: 'a',
    });
  });
});
