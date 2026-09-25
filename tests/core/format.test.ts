import { describe, expect, it } from 'vitest';
import { formatPercent, formatResetCountdown, formatSessionDuration, tildePath } from '../../src/core/format';

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
const MINUTE_MS = 60_000;

describe('formatResetCountdown', () => {
  const now = 1_000_000_000_000;

  it('formats days and hours', () => {
    const resetsAt = now + 3 * DAY_MS + 4 * HOUR_MS;
    expect(formatResetCountdown(resetsAt, now)).toBe('3d4h');
  });

  it('formats hours and minutes', () => {
    const resetsAt = now + 1 * HOUR_MS + 12 * MINUTE_MS;
    expect(formatResetCountdown(resetsAt, now)).toBe('1h12m');
  });

  it('formats sub-hour countdowns as 0hXm', () => {
    const resetsAt = now + 5 * MINUTE_MS;
    expect(formatResetCountdown(resetsAt, now)).toBe('0h5m');
  });

  it('returns null for a past reset', () => {
    expect(formatResetCountdown(now - 1_000, now)).toBeNull();
  });

  it('returns null for a null reset', () => {
    expect(formatResetCountdown(null, now)).toBeNull();
  });

  it('returns null for an undefined reset', () => {
    expect(formatResetCountdown(undefined, now)).toBeNull();
  });

  it('formats exactly 24h as 1d0h', () => {
    const resetsAt = now + DAY_MS;
    expect(formatResetCountdown(resetsAt, now)).toBe('1d0h');
  });
});

describe('formatSessionDuration', () => {
  const now = 1_000_000_000_000;

  it('formats 0 minutes', () => {
    expect(formatSessionDuration(now, now)).toBe('0m');
  });

  it('formats 59 minutes', () => {
    expect(formatSessionDuration(now - 59 * MINUTE_MS, now)).toBe('59m');
  });

  it('formats 1h0m at exactly 60 minutes', () => {
    expect(formatSessionDuration(now - 60 * MINUTE_MS, now)).toBe('1h0m');
  });
});

describe('formatPercent', () => {
  it('rounds to the nearest integer', () => {
    expect(formatPercent(46.67)).toBe('47%');
  });

  it('returns an em dash for null', () => {
    expect(formatPercent(null)).toBe('–');
  });

  it('returns an em dash for undefined', () => {
    expect(formatPercent(undefined)).toBe('–');
  });
});

describe('tildePath', () => {
  it('abbreviates the home directory only at a path boundary', () => {
    expect(tildePath('/Users/me/src/app', '/Users/me')).toBe('~/src/app');
    expect(tildePath('/Users/me', '/Users/me/')).toBe('~');
    expect(tildePath('/Users/meow/app', '/Users/me')).toBe('/Users/meow/app');
    expect(tildePath('/tmp/x', null)).toBe('/tmp/x');
  });
});
