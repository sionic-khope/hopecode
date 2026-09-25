import { effectivePercent, isAccountAvailable } from './rotationPolicy';
import type { Account, AccountUsage, LimitKind, PoolSummary } from '../shared/types';

const LIMIT_KINDS: readonly LimitKind[] = ['fiveHour', 'sevenDay', 'fable'];

/**
 * Pool-wide summary for the statusline (plan 4.1).
 * - enabled accounts only; readings with `resetsAt <= now` count as 0%.
 * - avg per kind over accounts that have that kind (null when none).
 * - earliestReset = min future resetsAt among enabled accounts.
 * - available = enabled accounts passing isAccountAvailable (5h/wk only), total = enabled count.
 */
export function summarizePool(
  accounts: Account[],
  usageById: Record<string, AccountUsage>,
  now: number,
): PoolSummary {
  const enabled = accounts.filter((a) => a.enabled);

  const avg = {} as Record<LimitKind, number | null>;
  const earliestReset = {} as Record<LimitKind, number | null>;

  for (const kind of LIMIT_KINDS) {
    let sum = 0;
    let count = 0;
    let earliest: number | null = null;

    for (const account of enabled) {
      const reading = usageById[account.id]?.[kind];
      if (!reading) continue;

      count += 1;
      sum += effectivePercent(reading, now);

      if (reading.resetsAt !== null && reading.resetsAt > now) {
        if (earliest === null || reading.resetsAt < earliest) earliest = reading.resetsAt;
      }
    }

    avg[kind] = count > 0 ? sum / count : null;
    earliestReset[kind] = earliest;
  }

  const available = enabled.filter((a) => isAccountAvailable(usageById[a.id], now)).length;

  return { avg, earliestReset, available, total: enabled.length };
}
