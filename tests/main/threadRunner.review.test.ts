// Review fixes in ThreadRunner / SessionManager (H4, M2, M3, L2, contract 6 error events, project trust).
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeScenario } from '../../src/main/fixtures/fakeQuery';
import type { QueryFn } from '../../src/main/contracts';
import {
  createMemoryStore,
  createMemoryThreadLog,
  createMemoryUsagePoller,
  createRecordingBroadcaster,
  createStaticClaudeBinary,
  createStaticShellEnv,
  makeAccount,
  makeThread,
} from '../../src/main/fixtures/memoryDeps';
import { createSessionManager } from '../../src/main/session/sessionManager';
import { createSessionHarness, type SessionHarness } from '../../src/main/fixtures/sessionHarness';
import { MINUTE_MS } from '../../src/shared/constants';
import type { ChatEvent, ChatItem, Thread } from '../../src/shared/types';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'hopecode-runner-'));
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(root, { recursive: true, force: true });
});

function setup(opts: {
  accounts: string[];
  thread?: Partial<Thread>;
  scenario?: FakeScenario;
  trusted?: boolean;
  settings?: { idleCloseMinutes: number };
}): SessionHarness {
  const h = createSessionHarness({
    accounts: opts.accounts.map((id, i) => makeAccount(id, { priority: i, configDir: join(root, 'accounts', id) })),
    threads: [makeThread('t1', { cwd: join(root, 'work'), ...opts.thread })],
    scenario: opts.scenario,
    writeTranscript: true,
    settings: opts.settings,
  });
  h.store.update((d) => {
    d.projects.push({ id: 'project-1', name: 'p', path: '/p', trusted: opts.trusted ?? false, createdAt: 0 });
  });
  return h;
}

const events = (h: SessionHarness): ChatEvent[] => h.broadcaster.of('chat:event').map((e) => e.event);

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 0));
  if (!cond()) throw new Error('condition not reached');
}

describe('ThreadRunner review fixes', () => {
  it('(H4) a thread deleted while its turn is rate limited is never retried', async () => {
    const h = setup({
      accounts: ['A', 'B'],
      scenario: ({ callIndex }) =>
        callIndex === 0
          ? [{ type: 'rateLimit', info: { status: 'rejected', rateLimitType: 'five_hour' } }]
          : [{ type: 'text', text: 'retry' }],
    });
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      // thread:delete order: closeThread (awaited) first, the store entry goes afterwards.
      // It starts at the moment the rejection is reported, i.e. before the retry decision.
      let closing: Promise<void> | null = null;
      h.usage.onUpdate(() => {
        if (closing) return;
        closing = h.manager.closeThread('t1').then(() =>
          h.store.update((d) => {
            d.threads = [];
          }),
        );
      });
      await h.manager.send('t1', 'hi');
      await until(() => closing !== null);
      await closing;
      await h.manager.whenSettled('t1');
      await new Promise((r) => setTimeout(r, 10));
      expect(h.fake.calls).toHaveLength(1);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('(M2) an interrupted partial reply is finalized as an item and the next turn starts clean', async () => {
    const h = setup({
      accounts: ['A'],
      scenario: ({ turnIndex }) =>
        turnIndex === 0 ? [{ type: 'partial', text: 'half an ans' }, { type: 'pause' }] : [{ type: 'text', text: 'second' }],
    });
    await h.manager.send('t1', 'one');
    await until(() => events(h).some((e) => e.type === 'text-delta'));
    await h.manager.interrupt('t1');
    await h.manager.whenSettled('t1');

    const texts = (): ChatItem[] => (h.threadLog.items.get('t1') ?? []).filter((i) => i.type === 'assistant-text');
    expect(texts().map((i) => (i as { text: string }).text)).toEqual(['half an ans']);
    const partialId = texts()[0]!.id;
    expect(events(h)).toContainEqual({ type: 'turn-end', ok: false, reason: 'interrupted' });

    await h.manager.send('t1', 'two');
    await h.manager.whenSettled('t1');
    const after = texts();
    expect(after.map((i) => (i as { text: string }).text)).toEqual(['half an ans', 'second']);
    expect(after[1]!.id).not.toBe(partialId);
  });

  it('(M3) a new Query waits for the idle-closed one to exit', async () => {
    vi.useFakeTimers();
    const h = setup({ accounts: ['A'], settings: { idleCloseMinutes: 1 } });
    await h.manager.send('t1', 'one');
    await h.manager.whenSettled('t1');
    // Fire the idle close synchronously and send before the CLI had a chance to exit.
    vi.advanceTimersByTime(MINUTE_MS);
    expect(h.fake.timeline).toContain('close:0');
    expect(h.fake.timeline).not.toContain('end:0');
    const sent = h.manager.send('t1', 'two');
    await vi.runAllTimersAsync();
    await sent;
    await h.manager.whenSettled('t1');
    const t = h.fake.timeline;
    expect(t.indexOf('end:0')).toBeGreaterThanOrEqual(0);
    expect(t.indexOf('end:0')).toBeLessThan(t.indexOf('open:1'));
  });

  it('(L2) Stop while the Query is still opening cancels the turn before the prompt is sent', async () => {
    const sid = '11111111-2222-4333-8444-555555555555';
    const h = setup({ accounts: ['A', 'B'], thread: { sdkSessionId: sid, lastAccountId: 'B' } });
    h.usage.set('B', { fiveHour: { percent: 100, resetsAt: Date.now() + 3_600_000 }, fetchedAt: Date.now(), stale: false });
    const sent = h.manager.send('t1', 'hi');
    // prepareQuery is awaiting the transcript copy: no live turn yet.
    await h.manager.interrupt('t1');
    await sent;
    await h.manager.whenSettled('t1');
    expect(h.fake.calls.every((c) => c.prompts.length === 0)).toBe(true);
    expect(h.thread('t1').status).toBe('idle');
    expect(events(h)).toContainEqual({ type: 'turn-end', ok: false, reason: 'interrupted' });
  });

  it('(contract 6) an is_error result surfaces its message as an error event and a persisted notice', async () => {
    const h = setup({ accounts: ['A'], scenario: () => [{ type: 'result', isError: true, message: 'Prompt is too long' }] });
    await h.manager.send('t1', 'hi');
    await h.manager.whenSettled('t1');
    expect(events(h)).toContainEqual({ type: 'error', message: 'Prompt is too long' });
    expect(events(h)).toContainEqual({ type: 'turn-end', ok: false, reason: 'error' });
    const persisted = (h.threadLog.items.get('t1') ?? []).filter((i) => i.type === 'notice');
    expect(persisted).toEqual([expect.objectContaining({ level: 'error', text: 'Prompt is too long' })]);
    // Not rendered twice live: the notice is not broadcast as an item.
    expect(events(h).filter((e) => e.type === 'item-upsert' && e.item.type === 'notice')).toHaveLength(0);
  });

  it('(contract 6) a CLI start failure is reported as an error event', async () => {
    const accounts = [makeAccount('A', { configDir: join(root, 'accounts', 'A') })];
    const store = createMemoryStore({ threads: [makeThread('t1', { cwd: join(root, 'work') })], accounts });
    const broadcaster = createRecordingBroadcaster();
    const manager = createSessionManager({
      query: (() => {
        throw new Error('spawn claude ENOENT');
      }) as unknown as QueryFn,
      store,
      threadLog: createMemoryThreadLog(),
      listAccounts: () => accounts,
      usage: createMemoryUsagePoller(() => accounts),
      shellEnv: createStaticShellEnv(),
      claudeBinary: createStaticClaudeBinary(),
      broadcaster,
      appVersion: '0.1.0',
      log: () => {},
    });
    await manager.send('t1', 'hi');
    await manager.whenSettled('t1');
    const errs = broadcaster.of('chat:event').filter((e) => e.event.type === 'error');
    expect(errs.map((e) => e.event)).toEqual([{ type: 'error', message: 'Claude Code를 시작하지 못했습니다: spawn claude ENOENT' }]);
    expect(store.getThread('t1')!.status).toBe('error');
  });

  it('(trust) untrusted projects load user settings only; trusting reopens the Query with project settings', async () => {
    const h = setup({ accounts: ['A'] });
    await h.manager.send('t1', 'one');
    await h.manager.whenSettled('t1');
    expect(h.fake.calls[0]!.options.settingSources).toEqual(['user']);
    const sid = h.fake.calls[0]!.sessionId;

    h.store.update((d) => {
      d.projects[0]!.trusted = true;
    });
    await h.manager.send('t1', 'two');
    await h.manager.whenSettled('t1');
    expect(h.fake.calls).toHaveLength(2);
    expect(h.fake.calls[0]!.closed).toBe(true);
    expect(h.fake.calls[1]!.options.settingSources).toEqual(['user', 'project', 'local']);
    expect(h.fake.calls[1]!.resume).toBe(sid);
  });

  it('(L10) a malformed stored session id is never resumed', async () => {
    const h = setup({ accounts: ['A'], thread: { sdkSessionId: '../../etc/passwd', lastAccountId: 'A' } });
    await h.manager.send('t1', 'hi');
    await h.manager.whenSettled('t1');
    expect(h.fake.calls[0]!.resume).toBeUndefined();
  });

  it('closeAccount closes only that account’s Queries and waits for the CLI to exit', async () => {
    const h = setup({ accounts: ['A'] });
    await h.manager.send('t1', 'hi');
    await h.manager.whenSettled('t1');
    await h.manager.closeAccount('B');
    expect(h.fake.calls[0]!.closed).toBe(false);
    await h.manager.closeAccount('A');
    expect(h.fake.calls[0]!.closed).toBe(true);
    expect(h.fake.calls[0]!.ended).toBe(true);
  });

  it('pendingPermissions() lists unanswered requests; abortAll() aborts the CLI processes', async () => {
    const h = setup({ accounts: ['A'], scenario: () => [{ type: 'tool', name: 'Bash', input: { command: 'ls' }, permission: true }] });
    await h.manager.send('t1', 'run');
    await until(() => h.manager.pendingPermissions().length === 1);
    expect(h.manager.pendingPermissions()[0]).toMatchObject({ threadId: 't1', toolName: 'Bash' });
    const abort = h.fake.calls[0]!.options.abortController!;
    h.manager.abortAll();
    expect(abort.signal.aborted).toBe(true);
    expect(h.manager.pendingPermissions()).toHaveLength(0);
  });
});
