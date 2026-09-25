import { FALLBACK_BLOCK_MS } from '../shared/constants';
import type { AccountUsage, LimitReading, ModelLimitKind, PickAccountInput, PickDecision } from '../shared/types';

/** Percent after considering reset: `resetsAt <= now` -> 0. Undefined reading -> 0. */
export function effectivePercent(reading: LimitReading | undefined, now: number): number {
  if (!reading) return 0;
  if (reading.resetsAt !== null && reading.resetsAt <= now) return 0;
  return reading.percent;
}

function notFuture(until: number | undefined, now: number): boolean {
  return until === undefined || until <= now;
}

/** Model-scoped limit bucket a resolved model id falls into (`claude-opus-5-5` -> opus). */
export function modelKindOf(resolvedModel: string | null | undefined): ModelLimitKind | null {
  if (!resolvedModel) return null;
  if (/fable/i.test(resolvedModel)) return 'fable';
  if (/opus/i.test(resolvedModel)) return 'opus';
  if (/sonnet/i.test(resolvedModel)) return 'sonnet';
  return null;
}

/**
 * Not auth-failed, 5h / wk effective < 100 and no future rejectedUntil.fiveHour/sevenDay/overage.
 * Model-scoped buckets (fable reading + rejectedUntil.fable/opus/sonnet) only apply when `resolvedModel` is that model.
 */
export function isAccountAvailable(
  usage: AccountUsage | undefined,
  now: number,
  opts?: { resolvedModel?: string | null },
): boolean {
  // Auth failure is cleared by the next successful poll (the poller rebuilds usage without `error`).
  if (usage?.error === 'auth') return false;
  const fiveHour = effectivePercent(usage?.fiveHour, now);
  const sevenDay = effectivePercent(usage?.sevenDay, now);
  if (fiveHour >= 100 || sevenDay >= 100) return false;

  const rejectedUntil = usage?.rejectedUntil;
  if (!notFuture(rejectedUntil?.fiveHour, now)) return false;
  if (!notFuture(rejectedUntil?.sevenDay, now)) return false;
  if (!notFuture(rejectedUntil?.overage, now)) return false;

  const modelKind = modelKindOf(opts?.resolvedModel);
  if (modelKind === 'fable' && effectivePercent(usage?.fable, now) >= 100) return false;
  if (modelKind && !notFuture(rejectedUntil?.[modelKind], now)) return false;

  return true;
}

/** Time (epoch ms) at which this account becomes available again, given the blocking windows currently active. */
function accountAvailableAt(usage: AccountUsage | undefined, now: number, resolvedModel: string | null): number {
  const times: number[] = [];

  const considerReading = (reading: LimitReading | undefined) => {
    if (reading && effectivePercent(reading, now) >= 100 && reading.resetsAt !== null && reading.resetsAt > now) {
      times.push(reading.resetsAt);
    }
  };
  const considerRejected = (until: number | undefined) => {
    if (until !== undefined && until > now) times.push(until);
  };

  considerReading(usage?.fiveHour);
  considerReading(usage?.sevenDay);
  considerRejected(usage?.rejectedUntil?.fiveHour);
  considerRejected(usage?.rejectedUntil?.sevenDay);
  considerRejected(usage?.rejectedUntil?.overage);

  const modelKind = modelKindOf(resolvedModel);
  if (modelKind === 'fable') considerReading(usage?.fable);
  if (modelKind) considerRejected(usage?.rejectedUntil?.[modelKind]);

  if (times.length === 0) return now + FALLBACK_BLOCK_MS;
  return Math.max(...times);
}

/**
 * pinned (enabled & available) -> priority asc (enabled & available) -> waiting(until) -> none (plan 4.1).
 * Every enabled account auth-failed -> none (`reason: 'auth'`): no reset time would ever make one available.
 */
export function pickAccount(input: PickAccountInput): PickDecision {
  const { accounts, usageById, pinnedAccountId, exclude, now } = input;
  // Model not resolved yet (no session init): an explicit thread model still decides the model-scoped limits.
  const resolvedModel = input.resolvedModel ?? (input.model && input.model !== 'default' ? input.model : null);

  const enabled = accounts.filter((a) => a.enabled);
  if (enabled.length === 0) return { type: 'none' };
  const authOk = enabled.filter((a) => usageById[a.id]?.error !== 'auth');
  if (authOk.length === 0) return { type: 'none', reason: 'auth' };

  const isExcluded = (id: string) => exclude?.has(id) ?? false;
  const availableEnabled = (accountId: string) =>
    !isExcluded(accountId) && isAccountAvailable(usageById[accountId], now, { resolvedModel });

  if (pinnedAccountId) {
    const pinned = enabled.find((a) => a.id === pinnedAccountId);
    if (pinned && availableEnabled(pinned.id)) {
      return { type: 'account', accountId: pinned.id };
    }
  }

  const sorted = [...enabled].sort((a, b) => a.priority - b.priority);
  for (const a of sorted) {
    if (availableEnabled(a.id)) return { type: 'account', accountId: a.id };
  }

  let minUntil = Infinity;
  for (const a of authOk) {
    const until = accountAvailableAt(usageById[a.id], now, resolvedModel);
    if (until < minUntil) minUntil = until;
  }
  if (!Number.isFinite(minUntil)) minUntil = now + FALLBACK_BLOCK_MS;

  return { type: 'waiting', until: minUntil };
}
