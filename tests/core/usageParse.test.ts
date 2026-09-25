import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyRateLimitEvent, normalizeEpoch, parseUsageResponse } from '../../src/core/usageParse';
import { isAccountAvailable } from '../../src/core/rotationPolicy';
import type { AccountUsage, RateLimitInfoLite } from '../../src/shared/types';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(__dirname, '../fixtures/usage', name), 'utf8'));

const NOW = Date.parse('2026-09-25T12:00:00.000Z');
const FIVE_MIN = 5 * 60_000;

describe('parseUsageResponse', () => {
  it('parses five_hour / seven_day with ISO dates', () => {
    const r = parseUsageResponse(fixture('normal.json'));
    expect(r).toEqual({
      fiveHour: { percent: 42.5, resetsAt: Date.parse('2026-09-25T15:00:00.000Z') },
      sevenDay: { percent: 13, resetsAt: Date.parse('2026-09-30T03:00:00.000Z') },
      extraUsageEnabled: false,
    });
    expect(r?.fable).toBeUndefined();
  });

  it('picks the fable weekly_scoped bucket case-insensitively, preferring is_active, ignoring sonnet/opus', () => {
    const r = parseUsageResponse(fixture('fable-limits.json'));
    expect(r?.fable).toEqual({ percent: 64.2, resetsAt: Date.parse('2026-10-01T09:30:00.000Z') });
    expect(r?.fiveHour?.percent).toBe(10);
    expect(r?.sevenDay?.percent).toBe(20);
  });

  it('does not mistake sonnet/opus buckets for fable', () => {
    const r = parseUsageResponse({
      five_hour: { utilization: 1, resets_at: null },
      limits: [
        { kind: 'weekly_scoped', percent: 90, is_active: true, scope: { model: { display_name: 'Sonnet 4.5' } } },
        { kind: 'weekly_scoped', percent: 80, is_active: true, scope: { model: { display_name: 'Opus' } } },
      ],
    });
    expect(r?.fable).toBeUndefined();
  });

  it('dedups the same display_name preferring is_active regardless of order', () => {
    const r = parseUsageResponse({
      limits: [
        { kind: 'weekly_scoped', percent: 70, is_active: true, scope: { model: { display_name: 'Fable' } } },
        { kind: 'weekly_scoped', percent: 10, is_active: false, scope: { model: { display_name: 'fable' } } },
      ],
    });
    expect(r?.fable?.percent).toBe(70);
  });

  it('clamps to 0..100 and nulls invalid dates', () => {
    const r = parseUsageResponse(fixture('clamp-invalid.json'));
    expect(r?.fiveHour).toEqual({ percent: 100, resetsAt: null });
    expect(r?.sevenDay).toEqual({ percent: 0, resetsAt: null });
    expect(r?.fable).toEqual({ percent: 100, resetsAt: null });
  });

  it('detects extra_usage enabled via is_enabled / limit_usd / monthly_limit', () => {
    expect(parseUsageResponse(fixture('extra-usage-enabled.json'))?.extraUsageEnabled).toBe(true);
    const base = { five_hour: { utilization: 1, resets_at: null } };
    expect(parseUsageResponse({ ...base, extra_usage: { limit_usd: 20 } })?.extraUsageEnabled).toBe(true);
    expect(parseUsageResponse({ ...base, extra_usage: { monthly_limit: 100 } })?.extraUsageEnabled).toBe(true);
    expect(parseUsageResponse({ ...base, extra_usage: { is_enabled: false, limit_usd: 0 } })?.extraUsageEnabled).toBe(
      false,
    );
    expect(parseUsageResponse({ ...base, extra_usage: null })?.extraUsageEnabled).toBe(false);
    expect(parseUsageResponse(base)?.extraUsageEnabled).toBe(false);
  });

  it('returns null for non-objects and responses without any usable data', () => {
    expect(parseUsageResponse(null)).toBeNull();
    expect(parseUsageResponse('x')).toBeNull();
    expect(parseUsageResponse([])).toBeNull();
    expect(parseUsageResponse({})).toBeNull();
    expect(parseUsageResponse({ five_hour: { utilization: null }, seven_day: null })).toBeNull();
  });
});

describe('normalizeEpoch', () => {
  it('converts seconds to ms and keeps ms', () => {
    expect(normalizeEpoch(1_790_000_000)).toBe(1_790_000_000_000);
    expect(normalizeEpoch(1_790_000_000_000)).toBe(1_790_000_000_000);
  });
});

describe('applyRateLimitEvent', () => {
  const base: AccountUsage = {
    fiveHour: { percent: 50, resetsAt: NOW + 3_600_000 },
    sevenDay: { percent: 20, resetsAt: NOW + 86_400_000 },
    fetchedAt: NOW - 1000,
    stale: false,
  };

  it('rejected five_hour -> rejectedUntil.fiveHour (epoch seconds normalized)', () => {
    const resetSec = Math.floor((NOW + 3_600_000) / 1000);
    const r = applyRateLimitEvent(base, { status: 'rejected', rateLimitType: 'five_hour', resetsAt: resetSec }, NOW);
    expect(r.rejectedUntil?.fiveHour).toBe(resetSec * 1000);
    expect(base.rejectedUntil).toBeUndefined(); // input not mutated
  });

  it('(M10) rejected seven_day_opus -> model-scoped opus only (not the whole account), overage -> overage', () => {
    const until = NOW + 7 * 86_400_000;
    const opus = applyRateLimitEvent(base, { status: 'rejected', rateLimitType: 'seven_day_opus', resetsAt: until }, NOW);
    expect(opus.rejectedUntil).toEqual({ opus: until });
    expect(isAccountAvailable(opus, NOW)).toBe(true);
    expect(isAccountAvailable(opus, NOW, { resolvedModel: 'claude-sonnet-5' })).toBe(true);
    expect(isAccountAvailable(opus, NOW, { resolvedModel: 'claude-opus-5-5' })).toBe(false);
    const sonnet = applyRateLimitEvent(base, { status: 'rejected', rateLimitType: 'seven_day_sonnet', resetsAt: until }, NOW);
    expect(sonnet.rejectedUntil).toEqual({ sonnet: until });
    const fable = applyRateLimitEvent(base, { status: 'rejected', rateLimitType: 'seven_day_fable', resetsAt: until }, NOW);
    expect(fable.rejectedUntil).toEqual({ fable: until });
    expect(isAccountAvailable(fable, NOW, { resolvedModel: 'claude-fable-5' })).toBe(false);
    expect(
      applyRateLimitEvent(base, { status: 'rejected', rateLimitType: 'seven_day', resetsAt: until }, NOW).rejectedUntil
        ?.sevenDay,
    ).toBe(until);
    // Unknown type keeps the conservative 5h block.
    const unknown = { status: 'rejected', rateLimitType: 'something_new', resetsAt: until } as unknown as RateLimitInfoLite;
    expect(applyRateLimitEvent(base, unknown, NOW).rejectedUntil).toEqual({ fiveHour: until });
    expect(
      applyRateLimitEvent(base, { status: 'rejected', rateLimitType: 'overage', resetsAt: until }, NOW).rejectedUntil
        ?.overage,
    ).toBe(until);
  });

  it('rejected without resetsAt -> now + 5min', () => {
    const r = applyRateLimitEvent(undefined, { status: 'rejected', rateLimitType: 'five_hour' }, NOW);
    expect(r.rejectedUntil?.fiveHour).toBe(NOW + FIVE_MIN);
    expect(r.fetchedAt).toBe(NOW);
  });

  it('(L11) utilization is a fraction of the window -> percent (clamped)', () => {
    const r = applyRateLimitEvent(base, { status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.83 }, NOW);
    expect(r.fiveHour).toEqual({ percent: 83, resetsAt: base.fiveHour!.resetsAt });
    expect(r.rejectedUntil).toBeUndefined();
    // 1 = 100%, not 1%.
    const full = applyRateLimitEvent(base, { status: 'allowed', rateLimitType: 'seven_day', utilization: 1 }, NOW);
    expect(full.sevenDay?.percent).toBe(100);
    // Past the cap (>1) clamps to 100.
    const over = applyRateLimitEvent(base, { status: 'allowed', rateLimitType: 'seven_day', utilization: 1.3 }, NOW);
    expect(over.sevenDay?.percent).toBe(100);
  });

  it('keeps earlier rejectedUntil entries', () => {
    const a = applyRateLimitEvent(base, { status: 'rejected', rateLimitType: 'five_hour', resetsAt: NOW + 10 }, NOW);
    const b = applyRateLimitEvent(a, { status: 'rejected', rateLimitType: 'seven_day', resetsAt: NOW + 20 }, NOW);
    expect(b.rejectedUntil).toEqual({ fiveHour: NOW + 10, sevenDay: NOW + 20 });
  });

  it('(M3) isUsingOverage / overageInUse with status allowed -> rejectedUntil.overage -> unavailable', () => {
    const until = NOW + 3_600_000;
    const r1 = applyRateLimitEvent(base, { status: 'allowed', isUsingOverage: true, resetsAt: until }, NOW);
    expect(r1.rejectedUntil?.overage).toBe(until);
    expect(isAccountAvailable(r1, NOW)).toBe(false);

    const r2 = applyRateLimitEvent(base, { status: 'allowed', overageInUse: true }, NOW);
    expect(r2.rejectedUntil?.overage).toBe(NOW + FIVE_MIN);
    expect(isAccountAvailable(r2, NOW)).toBe(false);

    const r3 = applyRateLimitEvent(base, { status: 'allowed', overageInUse: true, overageResetsAt: 1_790_000_000 }, NOW);
    expect(r3.rejectedUntil?.overage).toBe(1_790_000_000_000);

    expect(isAccountAvailable(base, NOW)).toBe(true);
  });
});
