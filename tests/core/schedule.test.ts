import { afterAll, describe, expect, it } from 'vitest';
import { describeRepeat, evaluateSchedule, nextOccurrence, parseTime, validateScheduleInput } from '../../src/core/schedule';
import type { ScheduleRepeat } from '../../src/shared/nav';

// Local-time math is checked in a zone with DST (US Eastern: 2026-03-08 springs forward, 2026-11-01 falls back).
// Set at load time: describe bodies (and their fixtures) run before any beforeAll.
const previousTz = process.env.TZ;
process.env.TZ = 'America/New_York';
afterAll(() => {
  process.env.TZ = previousTz;
});

const local = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const fields = (ms: number) => {
  const d = new Date(ms);
  return [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()];
};

describe('parseTime', () => {
  it('accepts 24h HH:MM only', () => {
    expect(parseTime('09:05')).toEqual({ h: 9, m: 5 });
    expect(parseTime('23:59')).toEqual({ h: 23, m: 59 });
    expect(parseTime('24:00')).toBeNull();
    expect(parseTime('9:05')).toBeNull();
    expect(parseTime('12:60')).toBeNull();
  });
});

describe('nextOccurrence', () => {
  it('once: the time itself while in the future, then null', () => {
    const at = local(2026, 9, 27, 9, 0);
    expect(nextOccurrence({ kind: 'once', at }, at - 1)).toBe(at);
    expect(nextOccurrence({ kind: 'once', at }, at)).toBeNull();
  });

  it('daily: later today, else tomorrow', () => {
    const repeat: ScheduleRepeat = { kind: 'daily', time: '09:00' };
    expect(fields(nextOccurrence(repeat, local(2026, 9, 26, 8, 59))!)).toEqual([2026, 9, 26, 9, 0]);
    expect(fields(nextOccurrence(repeat, local(2026, 9, 26, 9, 0))!)).toEqual([2026, 9, 27, 9, 0]);
    // Month and year roll over.
    expect(fields(nextOccurrence(repeat, local(2026, 12, 31, 10, 0))!)).toEqual([2027, 1, 1, 9, 0]);
  });

  it('weekdays: skips Saturday and Sunday', () => {
    const repeat: ScheduleRepeat = { kind: 'weekdays', time: '08:30' };
    // 2026-09-25 is a Friday.
    expect(fields(nextOccurrence(repeat, local(2026, 9, 25, 9, 0))!)).toEqual([2026, 9, 28, 8, 30]);
    expect(new Date(nextOccurrence(repeat, local(2026, 9, 26, 12, 0))!).getDay()).toBe(1);
  });

  it('weekly: the given weekday, a week later when today already passed', () => {
    const repeat: ScheduleRepeat = { kind: 'weekly', weekday: 5, time: '17:00' };
    expect(fields(nextOccurrence(repeat, local(2026, 9, 25, 16, 0))!)).toEqual([2026, 9, 25, 17, 0]);
    expect(fields(nextOccurrence(repeat, local(2026, 9, 25, 17, 0))!)).toEqual([2026, 10, 2, 17, 0]);
  });

  it('keeps the wall-clock time across DST changes', () => {
    const repeat: ScheduleRepeat = { kind: 'daily', time: '09:00' };
    // Spring forward (the day is 23h long): still 09:00 local.
    const spring = nextOccurrence(repeat, local(2026, 3, 7, 10, 0))!;
    expect(fields(spring)).toEqual([2026, 3, 8, 9, 0]);
    expect(spring - local(2026, 3, 7, 9, 0)).toBe(23 * 3_600_000);
    // Fall back (25h).
    const fall = nextOccurrence(repeat, local(2026, 10, 31, 10, 0))!;
    expect(fields(fall)).toEqual([2026, 11, 1, 9, 0]);
    expect(fall - local(2026, 10, 31, 9, 0)).toBe(25 * 3_600_000);
  });

  it('a time inside the spring-forward gap runs once that day (shifted forward), not skipped', () => {
    const at = nextOccurrence({ kind: 'daily', time: '02:30' }, local(2026, 3, 7, 12, 0))!;
    expect(fields(at).slice(0, 3)).toEqual([2026, 3, 8]);
    expect(fields(nextOccurrence({ kind: 'daily', time: '02:30' }, at)!)).toEqual([2026, 3, 9, 2, 30]);
  });
});

describe('evaluateSchedule', () => {
  const daily: ScheduleRepeat = { kind: 'daily', time: '09:00' };
  const nine = local(2026, 9, 26, 9, 0);

  it('nothing before the time or when disabled', () => {
    expect(evaluateSchedule({ enabled: true, nextRunAt: nine, repeat: daily }, nine - 1)).toEqual({ due: null, missed: null, nextRunAt: nine });
    expect(evaluateSchedule({ enabled: false, nextRunAt: nine, repeat: daily }, nine + 1)).toEqual({ due: null, missed: null, nextRunAt: null });
  });

  it('runs an occurrence found within the grace window and moves to the next one', () => {
    const r = evaluateSchedule({ enabled: true, nextRunAt: nine, repeat: daily }, nine + 60_000);
    expect(r.due).toBe(nine);
    expect(r.missed).toBeNull();
    expect(fields(r.nextRunAt!)).toEqual([2026, 9, 27, 9, 0]);
  });

  it('an occurrence found after the grace window is missed, not run', () => {
    const r = evaluateSchedule({ enabled: true, nextRunAt: nine, repeat: daily }, nine + 10 * 60_000);
    expect(r.due).toBeNull();
    expect(r.missed).toEqual({ latest: nine, count: 1 });
  });

  it('several days closed: every passed occurrence counts as missed', () => {
    const r = evaluateSchedule({ enabled: true, nextRunAt: nine, repeat: daily }, local(2026, 9, 29, 12, 0));
    expect(r.due).toBeNull();
    expect(r.missed).toEqual({ latest: local(2026, 9, 29, 9, 0), count: 4 });
    expect(fields(r.nextRunAt!)).toEqual([2026, 9, 30, 9, 0]);
  });

  it('reopened right at an occurrence after missing earlier ones: earlier missed, the current one runs', () => {
    const now = local(2026, 9, 28, 9, 1);
    const r = evaluateSchedule({ enabled: true, nextRunAt: nine, repeat: daily }, now);
    expect(r.due).toBe(local(2026, 9, 28, 9, 0));
    expect(r.missed).toEqual({ latest: local(2026, 9, 27, 9, 0), count: 2 });
  });

  it('a one-off past its time is missed and leaves no next run', () => {
    const r = evaluateSchedule({ enabled: true, nextRunAt: nine, repeat: { kind: 'once', at: nine } }, nine + 3_600_000);
    expect(r).toEqual({ due: null, missed: { latest: nine, count: 1 }, nextRunAt: null });
  });
});

describe('validateScheduleInput', () => {
  const projectIds = new Set(['p1']);
  const base = {
    projectId: 'p1',
    prompt: '의존성 업데이트 확인',
    model: 'default',
    permissionMode: 'plan',
    effort: null,
    repeat: { kind: 'daily', time: '09:00' },
    enabled: true,
  };

  it('accepts a valid schedule', () => {
    const r = validateScheduleInput(base, { projectIds });
    expect(r.ok).toBe(true);
  });

  it('refuses bypassPermissions, unknown projects, empty prompts and bad times', () => {
    expect(validateScheduleInput({ ...base, permissionMode: 'bypassPermissions' }, { projectIds })).toMatchObject({ ok: false });
    expect(validateScheduleInput({ ...base, projectId: 'p2' }, { projectIds })).toMatchObject({ ok: false });
    expect(validateScheduleInput({ ...base, prompt: '   ' }, { projectIds })).toMatchObject({ ok: false });
    expect(validateScheduleInput({ ...base, repeat: { kind: 'daily', time: '25:00' } }, { projectIds })).toMatchObject({ ok: false });
    expect(validateScheduleInput({ ...base, repeat: { kind: 'weekly', weekday: 7, time: '09:00' } }, { projectIds })).toMatchObject({
      ok: false,
    });
  });

  it('refuses a one-off in the past when enabling', () => {
    const now = local(2026, 9, 26, 12, 0);
    const past = { ...base, repeat: { kind: 'once', at: now - 1 } };
    expect(validateScheduleInput(past, { projectIds, now })).toMatchObject({ ok: false, error: '이미 지난 시각입니다' });
    expect(validateScheduleInput({ ...past, enabled: false }, { projectIds, now }).ok).toBe(true);
  });
});

describe('describeRepeat', () => {
  it('Korean labels', () => {
    expect(describeRepeat({ kind: 'daily', time: '09:00' })).toBe('매일 09:00');
    expect(describeRepeat({ kind: 'weekdays', time: '08:30' })).toBe('평일 08:30');
    expect(describeRepeat({ kind: 'weekly', weekday: 1, time: '10:00' })).toBe('매주 월 10:00');
    expect(describeRepeat({ kind: 'once', at: local(2026, 9, 27, 9, 5) })).toBe('1회 · 9월 27일 09:05');
  });
});
