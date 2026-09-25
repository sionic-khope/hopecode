import { describe, expect, it } from 'vitest';
import { summarizePool } from '../../src/core/poolSummary';
import type { Account, AccountUsage, LimitReading } from '../../src/shared/types';

const NOW = 1_000_000_000_000;
const HOUR_MS = 60 * 60_000;

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

describe('summarizePool', () => {
  it('averages fiveHour across enabled accounts (100/40/0 -> 46.67)', () => {
    const accounts = [account({ id: 'a' }), account({ id: 'b' }), account({ id: 'c' })];
    const usageById = {
      a: usage({ fiveHour: reading(100, NOW + HOUR_MS) }),
      b: usage({ fiveHour: reading(40, NOW + HOUR_MS) }),
      c: usage({ fiveHour: reading(0, NOW + HOUR_MS) }),
    };
    const result = summarizePool(accounts, usageById, NOW);
    expect(result.avg.fiveHour).toBeCloseTo(46.666666, 4);
  });

  it('excludes disabled accounts from the average', () => {
    const accounts = [account({ id: 'a' }), account({ id: 'b', enabled: false })];
    const usageById = {
      a: usage({ fiveHour: reading(50, NOW + HOUR_MS) }),
      b: usage({ fiveHour: reading(0, NOW + HOUR_MS) }),
    };
    const result = summarizePool(accounts, usageById, NOW);
    expect(result.avg.fiveHour).toBe(50);
    expect(result.total).toBe(1);
  });

  it('excludes accounts with no reading for that kind from the denominator', () => {
    const accounts = [account({ id: 'a' }), account({ id: 'b' })];
    const usageById = { a: usage({ fiveHour: reading(80, NOW + HOUR_MS) }) };
    const result = summarizePool(accounts, usageById, NOW);
    expect(result.avg.fiveHour).toBe(80);
  });

  it('returns null when no enabled account has any reading for that kind', () => {
    const accounts = [account({ id: 'a' })];
    const usageById = { a: usage() };
    const result = summarizePool(accounts, usageById, NOW);
    expect(result.avg.fiveHour).toBeNull();
    expect(result.avg.sevenDay).toBeNull();
    expect(result.avg.fable).toBeNull();
  });

  it('treats a reading with resetsAt <= now as 0%', () => {
    const accounts = [account({ id: 'a' })];
    const usageById = { a: usage({ fiveHour: reading(90, NOW - 1000) }) };
    const result = summarizePool(accounts, usageById, NOW);
    expect(result.avg.fiveHour).toBe(0);
  });

  it('picks the earliest future resetsAt and ignores past ones', () => {
    const accounts = [account({ id: 'a' }), account({ id: 'b' }), account({ id: 'c' })];
    const usageById = {
      a: usage({ fiveHour: reading(50, NOW - 1000) }),
      b: usage({ fiveHour: reading(50, NOW + 2 * HOUR_MS) }),
      c: usage({ fiveHour: reading(50, NOW + HOUR_MS) }),
    };
    const result = summarizePool(accounts, usageById, NOW);
    expect(result.earliestReset.fiveHour).toBe(NOW + HOUR_MS);
  });

  it('counts available accounts model-independently (fable-only-exhausted account still counts)', () => {
    const accounts = [account({ id: 'a' }), account({ id: 'b' })];
    const usageById = {
      a: usage({ fiveHour: reading(50, NOW + HOUR_MS), sevenDay: reading(50, NOW + HOUR_MS) }),
      b: usage({
        fiveHour: reading(50, NOW + HOUR_MS),
        sevenDay: reading(50, NOW + HOUR_MS),
        fable: reading(100, NOW + HOUR_MS),
      }),
    };
    const result = summarizePool(accounts, usageById, NOW);
    expect(result.available).toBe(2);
  });

  it('excludes an account whose fiveHour/sevenDay/overage rejectedUntil is still in the future', () => {
    const accounts = [account({ id: 'a' }), account({ id: 'b' }), account({ id: 'c' })];
    const usageById = {
      a: usage({ rejectedUntil: { fiveHour: NOW + HOUR_MS } }),
      b: usage({ rejectedUntil: { sevenDay: NOW + HOUR_MS } }),
      c: usage({ rejectedUntil: { overage: NOW + HOUR_MS } }),
    };
    const result = summarizePool(accounts, usageById, NOW);
    expect(result.available).toBe(0);
    expect(result.total).toBe(3);
  });

  it('total equals the enabled account count regardless of usage data', () => {
    const accounts = [account({ id: 'a' }), account({ id: 'b' }), account({ id: 'c', enabled: false })];
    const result = summarizePool(accounts, {}, NOW);
    expect(result.total).toBe(2);
  });
});

describe('summarizePool auth failures', () => {
  it('(M1) excludes auth-failed accounts from available', () => {
    const accounts = [account({ id: 'a' }), account({ id: 'b' })];
    const result = summarizePool(accounts, { a: usage({ error: 'auth', stale: true }), b: usage() }, NOW);
    expect(result.available).toBe(1);
    expect(result.total).toBe(2);
  });
});
