// Pure schedule math for 예약: next occurrence in the local time zone (DST-safe: every occurrence is built from
// wall-clock fields with `new Date(y, m, d, h, min)`), and the "due / missed" judgment the main scheduler applies.
import { EFFORT_LEVELS, UI_PERMISSION_MODES } from '../shared/constants';
import type { Schedule, ScheduleInput, ScheduleRepeat, Weekday } from '../shared/nav';
import { formatDate, t } from '../shared/i18n';

/** An occurrence found later than this after its time was not run on time (app closed, machine asleep): "놓침". */
export const SCHEDULE_GRACE_MS = 5 * 60_000;
export const SCHEDULE_PROMPT_MAX = 20_000;
export const SCHEDULE_RUNS_KEPT = 20;
/** Upper bound when counting missed occurrences (a daily schedule closed for years stops counting here). */
const MAX_MISSED_COUNT = 999;

/** Weekday name (0 = Sunday) in the current language: `월` / `Mon` (short) or `월요일` / `Monday` (long). */
export function weekdayLabel(weekday: number, width: 'short' | 'long' = 'short'): string {
  // 2024-01-07 was a Sunday.
  return formatDate(new Date(2024, 0, 7 + weekday), { weekday: width });
}

/** `HH:MM` (24h) -> hours/minutes, or null. */
export function parseTime(time: string): { h: number; m: number } | null {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  return h <= 23 && m <= 59 ? { h, m } : null;
}

function atLocal(day: Date, h: number, m: number): number {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m, 0, 0).getTime();
}

function addDays(day: Date, n: number): Date {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() + n);
}

function dayAllowed(repeat: Exclude<ScheduleRepeat, { kind: 'once' }>, weekday: number): boolean {
  if (repeat.kind === 'daily') return true;
  if (repeat.kind === 'weekdays') return weekday >= 1 && weekday <= 5;
  return weekday === repeat.weekday;
}

/** First occurrence strictly after `after` (epoch ms), or null (a one-off already past, or an invalid time). */
export function nextOccurrence(repeat: ScheduleRepeat, after: number): number | null {
  if (repeat.kind === 'once') return repeat.at > after ? repeat.at : null;
  const t = parseTime(repeat.time);
  if (!t) return null;
  const start = new Date(after);
  for (let i = 0; i <= 8; i++) {
    const day = addDays(start, i);
    if (!dayAllowed(repeat, day.getDay())) continue;
    const at = atLocal(day, t.h, t.m);
    if (at > after) return at;
  }
  return null;
}

export interface ScheduleEvaluation {
  /** Occurrence to run now (found within the grace window), else null. */
  due: number | null;
  /** Occurrences that passed unrun (latest one, how many), else null. */
  missed: { latest: number; count: number } | null;
  /** nextRunAt after this evaluation. */
  nextRunAt: number | null;
}

/**
 * Walks every occurrence from `schedule.nextRunAt` up to `now`. The last one is run when it is at most
 * `graceMs` old; every other one (and the last when older) is missed and never run automatically.
 */
export function evaluateSchedule(
  schedule: Pick<Schedule, 'enabled' | 'nextRunAt' | 'repeat'>,
  now: number,
  graceMs: number = SCHEDULE_GRACE_MS,
): ScheduleEvaluation {
  const { nextRunAt } = schedule;
  if (!schedule.enabled || nextRunAt === null || nextRunAt > now) {
    return { due: null, missed: null, nextRunAt: schedule.enabled ? nextRunAt : null };
  }
  let latest = nextRunAt;
  let count = 1;
  for (let occ = nextOccurrence(schedule.repeat, latest); occ !== null && occ <= now; occ = nextOccurrence(schedule.repeat, occ)) {
    latest = occ;
    if (count <= MAX_MISSED_COUNT) count += 1;
  }
  const onTime = now - latest <= graceMs;
  const missedCount = onTime ? count - 1 : count;
  const missedLatest = onTime ? previousCounted(schedule.repeat, nextRunAt, latest) : latest;
  return {
    due: onTime ? latest : null,
    missed: missedCount > 0 && missedLatest !== null ? { latest: missedLatest, count: Math.min(missedCount, MAX_MISSED_COUNT) } : null,
    nextRunAt: nextOccurrence(schedule.repeat, now),
  };
}

/** The occurrence just before `last`, starting the walk at `first` (null when `last` is the first). */
function previousCounted(repeat: ScheduleRepeat, first: number, last: number): number | null {
  if (first === last) return null;
  let prev = first;
  for (let occ = nextOccurrence(repeat, first); occ !== null && occ < last; occ = nextOccurrence(repeat, occ)) prev = occ;
  return prev;
}

// ---------------------------------------------------------------------------
// Validation (main re-checks everything the renderer sends)
// ---------------------------------------------------------------------------

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseRepeat(raw: unknown): ScheduleRepeat | string {
  if (!isObj(raw)) return t('schedule.err.repeatRequired');
  switch (raw.kind) {
    case 'once':
      return typeof raw.at === 'number' && Number.isFinite(raw.at) ? { kind: 'once', at: Math.floor(raw.at) } : t('schedule.err.badAt');
    case 'daily':
    case 'weekdays':
      return typeof raw.time === 'string' && parseTime(raw.time) ? { kind: raw.kind, time: raw.time } : t('schedule.err.badTime');
    case 'weekly':
      if (typeof raw.time !== 'string' || !parseTime(raw.time)) return t('schedule.err.badTime');
      if (typeof raw.weekday !== 'number' || !Number.isInteger(raw.weekday) || raw.weekday < 0 || raw.weekday > 6) {
        return t('schedule.err.badWeekday');
      }
      return { kind: 'weekly', weekday: raw.weekday as Weekday, time: raw.time };
    default:
      return t('schedule.err.unknownRepeat');
  }
}

/**
 * Checks a schedule from the renderer. `bypassPermissions` is refused here (never trusted to the UI). A one-off
 * must lie in the future when `now` is given (creation / re-enabling).
 */
export function validateScheduleInput(
  raw: unknown,
  opts: { projectIds: ReadonlySet<string>; now?: number },
): { ok: true; input: ScheduleInput } | { ok: false; error: string } {
  if (!isObj(raw)) return { ok: false, error: t('schedule.err.missing') };
  if (typeof raw.projectId !== 'string' || !opts.projectIds.has(raw.projectId)) return { ok: false, error: t('schedule.err.pickProject') };
  if (typeof raw.prompt !== 'string' || raw.prompt.trim().length === 0) return { ok: false, error: t('schedule.err.enterPrompt') };
  if (raw.prompt.length > SCHEDULE_PROMPT_MAX) return { ok: false, error: t('schedule.err.promptTooLong') };
  if (typeof raw.model !== 'string' || raw.model.length === 0 || raw.model.length > 200) return { ok: false, error: t('schedule.err.badModel') };
  if (raw.permissionMode === 'bypassPermissions') return { ok: false, error: t('schedule.err.noBypass') };
  if (typeof raw.permissionMode !== 'string' || !(UI_PERMISSION_MODES as readonly string[]).includes(raw.permissionMode)) {
    return { ok: false, error: t('schedule.err.badMode') };
  }
  if (raw.effort !== null && !(typeof raw.effort === 'string' && (EFFORT_LEVELS as readonly string[]).includes(raw.effort))) {
    return { ok: false, error: t('schedule.err.badEffort') };
  }
  if (typeof raw.enabled !== 'boolean') return { ok: false, error: t('schedule.err.enabledRequired') };
  const repeat = parseRepeat(raw.repeat);
  if (typeof repeat === 'string') return { ok: false, error: repeat };
  if (repeat.kind === 'once' && opts.now !== undefined && raw.enabled && repeat.at <= opts.now) {
    return { ok: false, error: t('schedule.err.past') };
  }
  return {
    ok: true,
    input: {
      projectId: raw.projectId,
      prompt: raw.prompt,
      model: raw.model,
      permissionMode: raw.permissionMode as ScheduleInput['permissionMode'],
      effort: raw.effort as ScheduleInput['effort'],
      repeat,
      enabled: raw.enabled,
    },
  };
}

/** Local `HH:MM` of an epoch time. */
export function formatHm(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** "매일 09:00", "평일 09:00", "매주 월 09:00", "1회 · 9월 27일 09:00". */
export function describeRepeat(repeat: ScheduleRepeat): string {
  switch (repeat.kind) {
    case 'once': {
      const date = formatDate(repeat.at, { month: 'short', day: 'numeric' });
      return t('schedule.repeat.once', { date, time: formatHm(repeat.at) });
    }
    case 'daily':
      return t('schedule.repeat.daily', { time: repeat.time });
    case 'weekdays':
      return t('schedule.repeat.weekdays', { time: repeat.time });
    case 'weekly':
      return t('schedule.repeat.weekly', { day: weekdayLabel(repeat.weekday), time: repeat.time });
  }
}
