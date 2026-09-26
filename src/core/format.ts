import { DAY_MS, HOUR_MS, MINUTE_MS } from '../shared/constants';

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
 * Sidebar-style relative time in Korean: `방금`, `3분 전`, `2시간 전`, `어제`, `3일 전`, then `9월 3일`
 * (`2025년 9월 3일` in another year). Future times (clock skew) read as `방금`.
 */
export function formatRelativeTime(at: number, now: number): string {
  const diff = now - at;
  if (!Number.isFinite(diff) || diff < MINUTE_MS) return '방금';
  if (diff < HOUR_MS) return `${Math.floor(diff / MINUTE_MS)}분 전`;
  if (diff < DAY_MS) return `${Math.floor(diff / HOUR_MS)}시간 전`;
  const then = new Date(at);
  const today = new Date(now);
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const days = Math.ceil((startOfToday - at) / DAY_MS);
  if (days <= 1) return '어제';
  if (days < 7) return `${days}일 전`;
  const md = `${then.getMonth() + 1}월 ${then.getDate()}일`;
  return then.getFullYear() === today.getFullYear() ? md : `${then.getFullYear()}년 ${md}`;
}
