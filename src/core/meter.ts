import { METER_CRIT_PERCENT, METER_WARN_PERCENT } from '../shared/constants';

export type MeterLevel = 'ok' | 'warn' | 'crit';

/** `>= 90` crit, `>= 70` warn, else ok. */
export function meterLevel(percent: number): MeterLevel {
  if (percent >= METER_CRIT_PERCENT) return 'crit';
  if (percent >= METER_WARN_PERCENT) return 'warn';
  return 'ok';
}

/** percent -> 0..1 (clamped). */
export function meterFill(percent: number): number {
  return Math.max(0, Math.min(1, percent / 100));
}
