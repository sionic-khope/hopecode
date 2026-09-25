import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUsageHistory } from '../../src/main/persistence/usageHistory';
import { USAGE_HISTORY_RETENTION_MS, USAGE_SAMPLE_MIN_INTERVAL_MS } from '../../src/shared/constants';

describe('usageHistory', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hopecode-usage-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('always writes the first sample', async () => {
    const history = createUsageHistory(dir);
    const wrote = await history.append('acc1', { at: 1000, fiveHour: 10, sevenDay: 5, fable: null });
    expect(wrote).toBe(true);
    expect(await history.read('acc1', 10_000, 2000)).toHaveLength(1);
  });

  it('skips an unchanged sample inside the min interval', async () => {
    const history = createUsageHistory(dir);
    await history.append('acc1', { at: 1000, fiveHour: 10, sevenDay: 5, fable: null });
    const wrote = await history.append('acc1', { at: 2000, fiveHour: 10, sevenDay: 5, fable: null });
    expect(wrote).toBe(false);
    expect(await history.read('acc1', 10_000, 2000)).toHaveLength(1);
  });

  it('writes when values changed even inside the min interval', async () => {
    const history = createUsageHistory(dir);
    await history.append('acc1', { at: 1000, fiveHour: 10, sevenDay: 5, fable: null });
    const wrote = await history.append('acc1', { at: 2000, fiveHour: 20, sevenDay: 5, fable: null });
    expect(wrote).toBe(true);
    expect(await history.read('acc1', 10_000, 2000)).toHaveLength(2);
  });

  it('writes an unchanged sample once the min interval has elapsed', async () => {
    const history = createUsageHistory(dir);
    await history.append('acc1', { at: 0, fiveHour: 10, sevenDay: 5, fable: null });
    const wrote = await history.append('acc1', {
      at: USAGE_SAMPLE_MIN_INTERVAL_MS,
      fiveHour: 10,
      sevenDay: 5,
      fable: null,
    });
    expect(wrote).toBe(true);
  });

  it('read() filters samples by rangeMs relative to now', async () => {
    const history = createUsageHistory(dir);
    await history.append('acc1', { at: 0, fiveHour: 1, sevenDay: 1, fable: null });
    await history.append('acc1', { at: 5000, fiveHour: 2, sevenDay: 1, fable: null });
    const recent = await history.read('acc1', 1000, 5000);
    expect(recent).toEqual([{ at: 5000, fiveHour: 2, sevenDay: 1, fable: null }]);
  });

  it('compact() drops samples older than the 14-day retention window', async () => {
    const history = createUsageHistory(dir);
    const now = 100 * USAGE_HISTORY_RETENTION_MS;
    await history.append('acc1', { at: now - USAGE_HISTORY_RETENTION_MS - 1, fiveHour: 1, sevenDay: 1, fable: null });
    await history.append('acc1', { at: now - 1000, fiveHour: 2, sevenDay: 1, fable: null });
    await history.compact(now);
    const all = await history.read('acc1', USAGE_HISTORY_RETENTION_MS * 200, now);
    expect(all).toEqual([{ at: now - 1000, fiveHour: 2, sevenDay: 1, fable: null }]);
  });

  it('remove() deletes an account file', async () => {
    const history = createUsageHistory(dir);
    await history.append('acc1', { at: 0, fiveHour: 1, sevenDay: 1, fable: null });
    await history.remove('acc1');
    expect(await history.read('acc1', 100_000, 100_000)).toEqual([]);
  });
});
