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
