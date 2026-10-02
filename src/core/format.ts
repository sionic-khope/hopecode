import { DAY_MS, HOUR_MS, MINUTE_MS } from '../shared/constants';
import { formatDate, formatRelative, t } from '../shared/i18n';

/** `3d4h` / `1h12m` (floor); past or invalid -> null. */
export function formatResetCountdown(resetsAtMs: number | null | undefined, now: number): string | null {
  if (resetsAtMs === null || resetsAtMs === undefined) return null;
  const diff = resetsAtMs - now;
  if (diff <= 0) return null;

  const days = Math.floor(diff / DAY_MS);
  if (days > 0) {
    const hours = Math.floor((diff - days * DAY_MS) / HOUR_MS);
    return `${days}d${hours}h`;
  }

  const hours = Math.floor(diff / HOUR_MS);
  const minutes = Math.floor((diff - hours * HOUR_MS) / MINUTE_MS);
  return `${hours}h${minutes}m`;
}

/** `Xm`, or `XhYm` from 60 minutes. */
export function formatSessionDuration(startMs: number, now: number): string {
  const minutes = Math.floor((now - startMs) / MINUTE_MS);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return `${hours}h${remainder}m`;
}

/** Rounded integer + `%`; null/undefined -> `–`. */
export function formatPercent(n: number | null | undefined): string {
  if (n === null || n === undefined) return '–';
  return `${Math.round(n)}%`;
}

/** `/Users/me/src/app` -> `~/src/app` when under `home`; other paths unchanged. */
export function tildePath(path: string, home: string | null | undefined): string {
  if (!home) return path;
  const base = home.replace(/\/+$/, '');
  if (!base) return path;
  if (path === base) return '~';
  return path.startsWith(`${base}/`) ? `~${path.slice(base.length)}` : path;
}

/**
 * Sidebar-style relative time in the current language: `방금` / `just now`, `3분 전` / `3 minutes ago`, `어제`,
 * `3일 전`, then `9월 3일` / `Sep 3` (with the year in another year). Future times (clock skew) read as just now.
 */
export function formatRelativeTime(at: number, now: number): string {
  const diff = now - at;
  if (!Number.isFinite(diff) || diff < MINUTE_MS) return t('time.justNow');
  if (diff < HOUR_MS) return formatRelative(-Math.floor(diff / MINUTE_MS), 'minute');
  if (diff < DAY_MS) return formatRelative(-Math.floor(diff / HOUR_MS), 'hour');
  const then = new Date(at);
  const today = new Date(now);
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const days = Math.ceil((startOfToday - at) / DAY_MS);
  if (days <= 1) return formatRelative(-1, 'day', 'auto');
  if (days < 7) return formatRelative(-days, 'day');
  return then.getFullYear() === today.getFullYear()
    ? formatDate(then, { month: 'short', day: 'numeric' })
    : formatDate(then, { year: 'numeric', month: 'short', day: 'numeric' });
}
