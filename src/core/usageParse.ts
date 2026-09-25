import { FALLBACK_BLOCK_MS } from '../shared/constants';
import type { AccountUsage, LimitKind, LimitReading, ModelLimitKind, RateLimitInfoLite } from '../shared/types';

export type ParsedUsage = Omit<AccountUsage, 'fetchedAt' | 'stale'>;

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function clampPercent(v: number): number {
  return Math.max(0, Math.min(100, v));
}

/** ISO 8601 string -> epoch ms; missing / invalid -> null. */
function parseDate(v: unknown): number | null {
  if (typeof v !== 'string' || v.trim() === '') return null;
  const ms = new Date(v).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/** `{ utilization, resets_at }` window (five_hour / seven_day). */
function parseWindow(v: unknown): LimitReading | undefined {
  if (!isObj(v) || !isFiniteNumber(v.utilization)) return undefined;
  return { percent: clampPercent(v.utilization), resetsAt: parseDate(v.resets_at) };
}

/**
 * `limits[]` entries with `kind === 'weekly_scoped'` whose `scope.model.display_name` contains "fable"
 * (case-insensitive). Duplicates of the same display_name prefer `is_active: true`; among distinct fable
 * names the first wins (ported from OMC usage-api.js resolveScopedWeeklyLimits).
 */
function parseFable(limits: unknown): LimitReading | undefined {
  if (!Array.isArray(limits)) return undefined;
  const byName = new Map<string, { percent: number; resetsAt: unknown; isActive: boolean }>();
  for (const entry of limits) {
    if (!isObj(entry) || entry.kind !== 'weekly_scoped' || !isFiniteNumber(entry.percent)) continue;
    const scope = entry.scope;
    const model = isObj(scope) ? scope.model : undefined;
    const displayName = isObj(model) ? model.display_name : undefined;
    if (typeof displayName !== 'string' || displayName.trim() === '') continue;
    const key = displayName.trim().toLowerCase();
    if (!key.includes('fable')) continue;
    const isActive = entry.is_active === true;
    const existing = byName.get(key);
    if (!existing || (isActive && !existing.isActive)) {
      byName.set(key, { percent: entry.percent, resetsAt: entry.resets_at, isActive });
    }
  }
  const first = byName.values().next();
  if (first.done) return undefined;
  return { percent: clampPercent(first.value.percent), resetsAt: parseDate(first.value.resetsAt) };
}

/** `extra_usage` enabled when `is_enabled === true`, `limit_usd > 0` or `monthly_limit > 0`. */
function parseExtraUsage(v: unknown): boolean {
  if (!isObj(v)) return false;
  if (v.is_enabled === true) return true;
  if (isFiniteNumber(v.limit_usd) && v.limit_usd > 0) return true;
  if (isFiniteNumber(v.monthly_limit) && v.monthly_limit > 0) return true;
  return false;
}

/**
 * Parse `/api/oauth/usage` JSON (plan 0.2): five_hour / seven_day, limits[] weekly_scoped fable
 * (is_active dedup), clamp 0..100, ISO -> epoch ms, extra_usage -> extraUsageEnabled. Invalid -> null.
 */
export function parseUsageResponse(json: unknown): ParsedUsage | null {
  if (!isObj(json)) return null;
  const fiveHour = parseWindow(json.five_hour);
  const sevenDay = parseWindow(json.seven_day);
  const fable = parseFable(json.limits);
  const hasExtra = isObj(json.extra_usage);
  if (!fiveHour && !sevenDay && !fable && !hasExtra) return null;

  const out: ParsedUsage = { extraUsageEnabled: parseExtraUsage(json.extra_usage) };
  if (fiveHour) out.fiveHour = fiveHour;
  if (sevenDay) out.sevenDay = sevenDay;
  if (fable) out.fable = fable;
  return out;
}

/** epoch seconds -> ms when `n < 1e12`. */
export function normalizeEpoch(n: number): number {
  return n < 1e12 ? n * 1000 : n;
}

type RateLimitType = NonNullable<RateLimitInfoLite['rateLimitType']>;

/**
 * Model named by a model-scoped weekly type (`seven_day_opus`, `seven_day_sonnet`, `seven_day_fable`, ...).
 * Those buckets only block threads running that model (rotationPolicy checks resolvedModel).
 */
export function modelLimitKindOf(t: string | undefined): ModelLimitKind | null {
  const m = /^seven_day_(fable|opus|sonnet)$/.exec(t ?? '');
  return m ? (m[1] as ModelLimitKind) : null;
}

/** Block kind for a rejected window. Unknown / missing type is treated as the 5h window. */
function rejectKindOf(t: RateLimitType | undefined): LimitKind | ModelLimitKind | 'overage' {
  const model = modelLimitKindOf(t);
  if (model) return model;
  switch (t) {
    case 'overage':
      return 'overage';
    case 'seven_day':
    case 'seven_day_overage_included':
      return 'sevenDay';
    default:
      return 'fiveHour';
  }
}

/** Only the plain 5h / 7d windows map onto our readings; model-scoped weekly buckets are not "sevenDay" usage. */
function readingKindOf(t: RateLimitType | undefined): 'fiveHour' | 'sevenDay' | null {
  if (t === 'five_hour') return 'fiveHour';
  if (t === 'seven_day') return 'sevenDay';
  return null;
}

/**
 * The CLI reports utilization as the fraction of the window used (0..1, may exceed 1 past the cap;
 * SDK schema doc for `unifiedWindows`: "same scale as the top-level utilization field").
 */
function utilizationToPercent(u: number): number {
  return clampPercent(u * 100);
}

/**
 * Apply SDK rate_limit_event: rejected -> rejectedUntil[kind] (fallback now+5min); utilization -> percent;
 * isUsingOverage || overageInUse -> rejectedUntil.overage.
 */
export function applyRateLimitEvent(
  usage: AccountUsage | undefined,
  info: RateLimitInfoLite,
  now: number,
): AccountUsage {
  const next: AccountUsage = usage
    ? { ...usage, rejectedUntil: { ...usage.rejectedUntil } }
    : { fetchedAt: now, stale: false, rejectedUntil: {} };
  const rejectedUntil = next.rejectedUntil!;
  const resetsAt = isFiniteNumber(info.resetsAt) ? normalizeEpoch(info.resetsAt) : null;

  if (info.status === 'rejected') {
    rejectedUntil[rejectKindOf(info.rateLimitType)] = resetsAt ?? now + FALLBACK_BLOCK_MS;
  }

  const readingKind = readingKindOf(info.rateLimitType);
  if (readingKind && isFiniteNumber(info.utilization)) {
    const prev = next[readingKind];
    next[readingKind] = {
      percent: utilizationToPercent(info.utilization),
      resetsAt: resetsAt ?? prev?.resetsAt ?? null,
    };
  }

  if (info.isUsingOverage === true || info.overageInUse === true) {
    const overageResetsAt = isFiniteNumber(info.overageResetsAt) ? normalizeEpoch(info.overageResetsAt) : null;
    rejectedUntil.overage = resetsAt ?? overageResetsAt ?? now + FALLBACK_BLOCK_MS;
  }

  if (Object.keys(rejectedUntil).length === 0) delete next.rejectedUntil;
  return next;
}
