import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AGENT_USAGE_MAX_BACKOFF_MS,
  AGENT_USAGE_MIN_INTERVAL_MS,
  AGENT_USAGE_POLL_MS,
  createAgentUsageService,
  HERMES_USAGE_TIMEOUT_MS,
  type HermesExec,
} from '../../src/main/usage/agentUsage';
import { createRecordingBroadcaster } from '../../src/main/fixtures/memoryDeps';

const OK = JSON.stringify({
  provider: 'openai-codex',
  title: 'ChatGPT Pro',
  plan: 'pro',
  fetched_at: '2026-10-01T10:00:00Z',
  windows: [{ label: 'Current session', used_percent: 12, resets_at: null, detail: null }],
  unavailable_reason: null,
});

function setup(results: { code: number | null; stdout: string }[] | 'throw', installed = true) {
  let t = 1_000_000;
  const exec = vi.fn<HermesExec>(async () => {
    if (results === 'throw') throw new Error('spawn ENOENT');
    return results.shift() ?? { code: 0, stdout: OK };
  });
  const broadcaster = createRecordingBroadcaster();
  const log = vi.fn();
  const svc = createAgentUsageService({ hermes: () => (installed ? exec : null), broadcaster, now: () => t, log });
  return { svc, exec, broadcaster, log, advance: (ms: number) => (t += ms) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('agentUsage', () => {
  it('runs `hermes usage --json` (no --provider) with a 30s timeout and parses the snapshot', async () => {
    const t = setup([{ code: 0, stdout: OK }]);
    const snap = await t.svc.refresh('hermes');
    expect(t.exec).toHaveBeenCalledWith(['usage', '--json'], HERMES_USAGE_TIMEOUT_MS);
    expect(snap).toMatchObject({ agent: 'hermes', plan: 'pro', windows: [{ label: 'Current session', usedPercent: 12 }] });
    expect(t.svc.get('hermes')).toEqual(snap);
    expect(t.broadcaster.of('agentUsage:updated')).toEqual([{ agent: 'hermes', snapshot: snap }]);
  });

  it('exit 1 (custom provider) / spawn failure / not installed -> unavailable (null), stdout never logged', async () => {
    const t = setup([{ code: 1, stdout: 'secret-ish output' }]);
    expect(await t.svc.refresh('hermes')).toBeNull();
    expect(t.svc.get('hermes')).toBeNull();
    expect(t.log.mock.calls.flat().join(' ')).not.toContain('secret-ish');
    expect(t.broadcaster.of('agentUsage:updated')).toEqual([]);

    const thrown = setup('throw');
    expect(await thrown.svc.refresh('hermes')).toBeNull();

    const missing = setup([], false);
    expect(await missing.svc.refresh('hermes')).toBeNull();
    expect(missing.exec).not.toHaveBeenCalled();
  });

  it('Codex shows no limits in v1 and Claude is not served here: nothing runs', async () => {
    const t = setup([]);
    expect(await t.svc.refresh('codex')).toBeNull();
    expect(await t.svc.refresh('claude-code')).toBeNull();
    expect(t.exec).not.toHaveBeenCalled();
  });

  it('a snapshot going away is broadcast as null', async () => {
    const t = setup([{ code: 0, stdout: OK }, { code: 1, stdout: '' }]);
    await t.svc.refresh('hermes');
    t.advance(AGENT_USAGE_MIN_INTERVAL_MS);
    await t.svc.refresh('hermes');
    expect(t.broadcaster.of('agentUsage:updated').at(-1)).toEqual({ agent: 'hermes', snapshot: null });
  });

  it('throttles to one run per minute and dedupes in-flight refreshes', async () => {
    const t = setup([]);
    const [a, b] = await Promise.all([t.svc.refresh('hermes'), t.svc.refresh('hermes')]);
    expect(a).toEqual(b);
    expect(t.exec).toHaveBeenCalledTimes(1);
    t.advance(AGENT_USAGE_MIN_INTERVAL_MS - 1);
    await t.svc.refresh('hermes');
    expect(t.exec).toHaveBeenCalledTimes(1);
    t.advance(1);
    await t.svc.refresh('hermes');
    expect(t.exec).toHaveBeenCalledTimes(2);
  });

  it('failures back off by doubling up to 30 minutes', async () => {
    const t = setup(Array.from({ length: 10 }, () => ({ code: 1, stdout: '' })));
    const gaps = [AGENT_USAGE_POLL_MS, AGENT_USAGE_POLL_MS * 2, AGENT_USAGE_POLL_MS * 4, AGENT_USAGE_MAX_BACKOFF_MS, AGENT_USAGE_MAX_BACKOFF_MS];
    await t.svc.refresh('hermes');
    for (const [i, gap] of gaps.entries()) {
      t.advance(gap - 1);
      await t.svc.refresh('hermes');
      expect(t.exec).toHaveBeenCalledTimes(i + 1);
      t.advance(1);
      await t.svc.refresh('hermes');
      expect(t.exec).toHaveBeenCalledTimes(i + 2);
    }
  });

  it('setActive polls the selected Hermes thread every 5 minutes and stops when deselected', async () => {
    vi.useFakeTimers();
    let t = 0;
    const exec = vi.fn<HermesExec>(async () => ({ code: 0, stdout: OK }));
    const svc = createAgentUsageService({ hermes: () => exec, now: () => t });
    svc.setActive('hermes');
    await vi.advanceTimersByTimeAsync(0);
    expect(exec).toHaveBeenCalledTimes(1);
    t += AGENT_USAGE_POLL_MS;
    await vi.advanceTimersByTimeAsync(AGENT_USAGE_POLL_MS);
    expect(exec).toHaveBeenCalledTimes(2);
    svc.setActive(null);
    t += AGENT_USAGE_POLL_MS * 3;
    await vi.advanceTimersByTimeAsync(AGENT_USAGE_POLL_MS * 3);
    expect(exec).toHaveBeenCalledTimes(2);
    svc.setActive('codex');
    await vi.advanceTimersByTimeAsync(AGENT_USAGE_POLL_MS);
    expect(exec).toHaveBeenCalledTimes(2);
    svc.dispose();
  });
});
