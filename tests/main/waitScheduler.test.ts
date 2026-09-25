import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeAccount, makeThread } from '../../src/main/fixtures/memoryDeps';
import { createSessionHarness } from '../../src/main/fixtures/sessionHarness';
import { createWaitScheduler } from '../../src/main/session/waitScheduler';
import { CONTINUE_PROMPT, MINUTE_MS, WAIT_TICK_MS } from '../../src/shared/constants';
import type { Thread } from '../../src/shared/types';

const T0 = Date.parse('2026-09-25T12:00:00.000Z');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createWaitScheduler', () => {
  it('60s interval evaluates only due threads, comparing Date.now() with waitingUntil', async () => {
    const until: Record<string, number | null> = { a: T0 + 90_000, b: T0 + 10 * MINUTE_MS };
    const evaluate = vi.fn(async (id: string) => {
      until[id] = null;
    });
    const s = createWaitScheduler({ getWaitingUntil: (id) => until[id], evaluate });
    s.track('a');
    s.track('b');

    await vi.advanceTimersByTimeAsync(WAIT_TICK_MS);
    expect(evaluate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(WAIT_TICK_MS);
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(evaluate).toHaveBeenCalledWith('a', true);

    // Sleep: wall clock jumps past b's deadline without the interval firing in between.
    vi.setSystemTime(T0 + 11 * MINUTE_MS);
    await vi.advanceTimersByTimeAsync(WAIT_TICK_MS);
    expect(evaluate).toHaveBeenLastCalledWith('b', true);
    expect(s.tracked()).toEqual([]);
    // Interval is cleared once nothing is waiting.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reevaluate() checks every thread immediately with its due flag', async () => {
    const until: Record<string, number> = { a: T0 - 1, b: T0 + MINUTE_MS };
    const evaluate = vi.fn(async () => {});
    const s = createWaitScheduler({ getWaitingUntil: (id) => until[id], evaluate });
    s.track('a');
    s.track('b');
    await s.reevaluate();
    expect(evaluate.mock.calls).toEqual([
      ['a', true],
      ['b', false],
    ]);
    s.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('drops threads that are no longer waiting and never runs one thread twice concurrently', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const evaluate = vi.fn(() => gate);
    const waiting: Record<string, number | null> = { a: T0 - 1, gone: null };
    const s = createWaitScheduler({ getWaitingUntil: (id) => waiting[id], evaluate });
    s.track('a');
    s.track('gone');
    const first = s.reevaluate();
    await s.reevaluate();
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(s.tracked()).toEqual(['a']);
    release();
    await first;
  });

  it('evaluate errors are logged and do not stop the scheduler', async () => {
    const log = vi.fn();
    const s = createWaitScheduler({
      getWaitingUntil: () => T0 - 1,
      evaluate: async () => {
        throw new Error('boom');
      },
      log,
    });
    s.track('a');
    await s.reevaluate();
    expect(log).toHaveBeenCalled();
    expect(s.tracked()).toEqual(['a']);
    s.stop();
  });
});

function waitingSetup(thread: Partial<Thread> = {}) {
  const accounts = [makeAccount('A', { priority: 0 }), makeAccount('B', { priority: 1 })];
  const h = createSessionHarness({
    accounts,
    threads: [makeThread('t1', thread)],
    scenario: ({ prompt }) => [{ type: 'text', text: `re: ${prompt}` }],
  });
  // A resets in 30 min, B in 2h -> pool waits until A's reset.
  h.usage.set('A', { fiveHour: { percent: 100, resetsAt: T0 + 30 * MINUTE_MS }, fetchedAt: T0, stale: false });
  h.usage.set('B', { fiveHour: { percent: 100, resetsAt: T0 + 120 * MINUTE_MS }, fetchedAt: T0, stale: false });
  return h;
}

describe('SessionManager waiting (plan 7.2 / A5)', () => {
  it('(d) all accounts exhausted -> waiting; 60s tick after the reset resends the original prompt', async () => {
    const h = waitingSetup();
    expect(await h.manager.send('t1', 'hello')).toEqual({ accepted: true, reason: 'waiting' });
    let t = h.thread('t1');
    expect(t.status).toBe('waiting');
    expect(t.waitingUntil).toBe(T0 + 30 * MINUTE_MS);
    expect(t.pendingPrompt).toEqual({ text: 'hello', kind: 'original' });
    expect(h.manager.scheduler.tracked()).toEqual(['t1']);

    await vi.advanceTimersByTimeAsync(5 * WAIT_TICK_MS);
    expect(h.fake.calls).toHaveLength(0);

    vi.setSystemTime(T0 + 31 * MINUTE_MS);
    await vi.advanceTimersByTimeAsync(WAIT_TICK_MS);
    await h.manager.whenSettled('t1');

    expect(h.usage.refreshCount).toBeGreaterThanOrEqual(1);
    expect(h.fake.calls).toHaveLength(1);
    expect(h.fake.calls[0]!.configDir).toBe('/accounts/A');
    expect(h.fake.calls[0]!.prompts).toEqual(['hello']);
    t = h.thread('t1');
    expect(t.status).toBe('idle');
    expect(t.waitingUntil).toBeNull();
    expect(t.pendingPrompt).toBeNull();
    expect(h.manager.scheduler.tracked()).toEqual([]);
  });

  it('(d) reevaluate() (powerMonitor resume) resends immediately without waiting for the tick', async () => {
    const h = waitingSetup();
    await h.manager.send('t1', 'hello');
    vi.setSystemTime(T0 + 45 * MINUTE_MS);
    await h.manager.reevaluate();
    await h.manager.whenSettled('t1');
    expect(h.fake.calls).toHaveLength(1);
    expect(h.fake.calls[0]!.prompts).toEqual(['hello']);
    expect(h.thread('t1').status).toBe('idle');
  });

  it('(d) reevaluate() before the deadline resumes only when an account became available', async () => {
    const h = waitingSetup();
    await h.manager.send('t1', 'hello');
    await h.manager.reevaluate();
    expect(h.fake.calls).toHaveLength(0);
    expect(h.thread('t1').status).toBe('waiting');

    // usage:updated shows B was reset early.
    h.usage.set('B', { fiveHour: { percent: 3, resetsAt: null }, fetchedAt: T0, stale: false });
    await h.manager.reevaluate();
    await h.manager.whenSettled('t1');
    expect(h.fake.calls).toHaveLength(1);
    expect(h.fake.calls[0]!.configDir).toBe('/accounts/B');
  });

  it('(d) still exhausted at the deadline -> waitingUntil moves to the new reset time', async () => {
    const h = waitingSetup();
    await h.manager.send('t1', 'hello');
    // A's reset time was extended (e.g. weekly limit hit meanwhile).
    h.usage.set('A', { fiveHour: { percent: 100, resetsAt: T0 + 90 * MINUTE_MS }, fetchedAt: T0, stale: false });
    vi.setSystemTime(T0 + 31 * MINUTE_MS);
    await vi.advanceTimersByTimeAsync(WAIT_TICK_MS);
    expect(h.fake.calls).toHaveLength(0);
    expect(h.thread('t1').waitingUntil).toBe(T0 + 90 * MINUTE_MS);
    expect(h.thread('t1').status).toBe('waiting');
  });

  it('(j) send while waiting replaces pendingPrompt (merging a continue prompt); interrupt cancels waiting', async () => {
    const h = waitingSetup({
      status: 'waiting',
      waitingUntil: T0 + 30 * MINUTE_MS,
      pendingPrompt: { text: CONTINUE_PROMPT, kind: 'continue' },
    });
    h.manager.restore();
    expect(h.manager.scheduler.tracked()).toEqual(['t1']);

    expect(await h.manager.send('t1', 'also fix tests')).toEqual({ accepted: true, reason: 'waiting' });
    expect(h.thread('t1').pendingPrompt).toEqual({ text: `${CONTINUE_PROMPT}\n\nalso fix tests`, kind: 'original' });

    expect(await h.manager.send('t1', 'actually do X')).toEqual({ accepted: true, reason: 'waiting' });
    expect(h.thread('t1').pendingPrompt).toEqual({ text: 'actually do X', kind: 'original' });

    await h.manager.interrupt('t1');
    const t = h.thread('t1');
    expect(t.status).toBe('idle');
    expect(t.pendingPrompt).toBeNull();
    expect(t.waitingUntil).toBeNull();
    expect(h.manager.scheduler.tracked()).toEqual([]);

    vi.setSystemTime(T0 + 60 * MINUTE_MS);
    await vi.advanceTimersByTimeAsync(WAIT_TICK_MS);
    expect(h.fake.calls).toHaveLength(0);
  });

  it('restore(): a waiting thread whose deadline already passed is resent right away (7.3)', async () => {
    const h = waitingSetup({
      status: 'waiting',
      waitingUntil: T0 - MINUTE_MS,
      pendingPrompt: { text: 'queued before restart', kind: 'original' },
    });
    h.usage.set('A', { fiveHour: { percent: 20, resetsAt: null }, fetchedAt: T0, stale: false });
    h.manager.restore();
    await vi.advanceTimersByTimeAsync(0);
    await h.manager.whenSettled('t1');
    expect(h.fake.calls).toHaveLength(1);
    expect(h.fake.calls[0]!.prompts).toEqual(['queued before restart']);
  });

  it('rate-limited on the last available account -> waiting with the prompt, then resumes after reset', async () => {
    const accounts = [makeAccount('A')];
    const resetsAtSec = Math.floor((T0 + 20 * MINUTE_MS) / 1000);
    const h = createSessionHarness({
      accounts,
      threads: [makeThread('t1')],
      scenario: ({ callIndex }) =>
        callIndex === 0
          ? [{ type: 'rateLimit', info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: resetsAtSec } }]
          : [{ type: 'text', text: 'done' }],
    });
    await h.manager.send('t1', 'task');
    await h.manager.whenSettled('t1');
    expect(h.thread('t1').status).toBe('waiting');
    expect(h.thread('t1').waitingUntil).toBe(resetsAtSec * 1000);
    expect(h.thread('t1').pendingPrompt).toEqual({ text: 'task', kind: 'original' });

    vi.setSystemTime(T0 + 21 * MINUTE_MS);
    await vi.advanceTimersByTimeAsync(WAIT_TICK_MS);
    await h.manager.whenSettled('t1');
    expect(h.fake.calls).toHaveLength(2);
    expect(h.fake.calls[1]!.prompts).toEqual(['task']);
    expect(h.thread('t1').status).toBe('idle');
  });
});
