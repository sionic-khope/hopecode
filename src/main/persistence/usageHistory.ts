// `usage/<accountId>.jsonl` UsageSample append with dedup + 14-day retention
// (plan 3.2 / 4.2 persistence/usageHistory.ts, owned by 1B; 1C consumes it via the
// `UsageHistory` contract).
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { USAGE_HISTORY_RETENTION_MS, USAGE_SAMPLE_MIN_INTERVAL_MS } from '../../shared/constants';
import type { UsageSample } from '../../shared/types';
import type { UsageHistory } from '../contracts';
import { appendJsonl, compactJsonl, readAllJsonl } from './jsonl';
import { assertSafeId } from './safeId';

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT';
}

function sameValues(a: UsageSample, b: UsageSample): boolean {
  return a.fiveHour === b.fiveHour && a.sevenDay === b.sevenDay && a.fable === b.fable;
}

export function createUsageHistory(dir: string): UsageHistory {
  const fileFor = (accountId: string): string => join(dir, `${assertSafeId(accountId, 'accountId')}.jsonl`);
  const lastByAccount = new Map<string, UsageSample>();

  async function lastSample(accountId: string): Promise<UsageSample | undefined> {
    const cached = lastByAccount.get(accountId);
    if (cached) return cached;
    const all = await readAllJsonl<UsageSample>(fileFor(accountId));
    const last = all.at(-1);
    if (last) lastByAccount.set(accountId, last);
    return last;
  }

  return {
    async append(accountId, sample) {
      const last = await lastSample(accountId);
      const shouldWrite = !last || !sameValues(last, sample) || sample.at - last.at >= USAGE_SAMPLE_MIN_INTERVAL_MS;
      if (!shouldWrite) return false;
      await appendJsonl(fileFor(accountId), sample);
      lastByAccount.set(accountId, sample);
      return true;
    },
    async read(accountId, rangeMs, now = Date.now()) {
      const all = await readAllJsonl<UsageSample>(fileFor(accountId));
      const cutoff = now - rangeMs;
      return all.filter((sample) => sample.at >= cutoff);
    },
    async compact(now = Date.now()) {
      const cutoff = now - USAGE_HISTORY_RETENTION_MS;
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch (err) {
        if (isEnoent(err)) return;
        throw err;
      }
      await Promise.all(
        entries
          .filter((name) => name.endsWith('.jsonl'))
          .map((name) => compactJsonl<UsageSample>(join(dir, name), (sample) => sample.at >= cutoff)),
      );
    },
    async remove(accountId) {
      lastByAccount.delete(accountId);
      try {
        await rm(fileFor(accountId));
      } catch (err) {
        if (!isEnoent(err)) throw err;
      }
    },
  };
}
