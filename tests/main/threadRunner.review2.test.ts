// Second review round (non-blocking items): account removal races (1, 8), hung CLI on quit (3),
// all-accounts-auth-failed send result (5), rate-limit partial flush duplicates (7).
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { QueryFn } from '../../src/main/contracts';
import { createFakeQuery } from '../../src/main/fixtures/fakeQuery';
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
import { createSessionHarness, type SessionHarness } from '../../src/main/fixtures/sessionHarness';
import { createSessionManager } from '../../src/main/session/sessionManager';
import type { Account, ChatItem, Thread } from '../../src/shared/types';

const SID = '11111111-2222-4333-8444-555555555555';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'hopecode-runner2-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function accountsFor(ids: string[]): Account[] {
  return ids.map((id, i) => makeAccount(id, { priority: i, configDir: join(root, 'accounts', id) }));
}

function setup(opts: { accounts: string[]; thread?: Partial<Thread>; scenario?: Parameters<typeof createSessionHarness>[0]['scenario'] }): SessionHarness {
  return createSessionHarness({
    accounts: accountsFor(opts.accounts),
    threads: [makeThread('t1', { cwd: join(root, 'work'), ...opts.thread })],
    scenario: opts.scenario,
    writeTranscript: true,
  });
}

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !cond(); i++) await new Promise((r) => setTimeout(r, 0));
  if (!cond()) throw new Error('condition not reached');
}

const logItems = (log: { items: Map<string, ChatItem[]> }): ChatItem[] => log.items.get('t1') ?? [];

/** Minimal SDK Query over an async generator (close() is ignored: a CLI that does not exit on its own). */
function scriptedQuery(gen: (options: Options) => AsyncGenerator<Record<string, unknown>>) {
  const state = { closed: 0 };
  const query = ((params: { options?: Options }) => {
    const it = gen(params.options ?? {}) as unknown as AsyncGenerator<SDKMessage>;
    return Object.assign(it, {
      async interrupt() {},
      close() {
        state.closed += 1;
      },
      async setPermissionMode() {},
      async setModel() {},
      async supportedModels() {
        return [];
      },
      async getContextUsage() {
        return { percentage: 1 };
      },
    }) as unknown as Query;
  }) as QueryFn;
  return { query, state };
}

describe('ThreadRunner review round 2', () => {
  it('(1) an account disabled while its Query is being prepared is not used; the turn re-picks', async () => {
    const h = setup({ accounts: ['A', 'B'], thread: { sdkSessionId: SID, lastAccountId: 'B' } });
    // A is picked, then the transcript sync from B awaits: A is disabled (account:remove) meanwhile.
    const sent = h.manager.send('t1', 'hi');
    h.accounts[0]!.enabled = false;
    const released = h.manager.closeAccount('A');
    expect(await sent).toEqual({ accepted: true });
    await released;
    await h.manager.whenSettled('t1');
    expect(h.fake.calls).toHaveLength(1);
    expect(h.fake.calls[0]!.configDir).toBe(join(root, 'accounts', 'B'));
    expect(h.thread('t1')).toMatchObject({ status: 'idle', activeAccountId: 'B' });
  });

  it('(1) with no other account left the re-pick ends the turn instead of running on the removed one', async () => {
    const h = setup({ accounts: ['A', 'B'], thread: { sdkSessionId: SID, lastAccountId: 'B' } });
    h.accounts[1]!.enabled = false;
    const sent = h.manager.send('t1', 'hi');
    h.accounts[0]!.enabled = false;
    expect(await sent).toEqual({ accepted: false, reason: 'no-accounts' });
    expect(h.fake.calls).toHaveLength(0);
    expect(h.thread('t1')).toMatchObject({ status: 'idle', activeAccountId: null });
  });

  it('(1, 8) closeAccount waits for the cut turn to settle and leaves an "account removed" notice', async () => {
    const h = setup({ accounts: ['A', 'B'], scenario: () => [{ type: 'partial', text: 'work' }, { type: 'pause' }] });
    await h.manager.send('t1', 'hi');
    await until(() => h.fake.timeline.includes('prompt:0'));
    h.accounts[0]!.enabled = false;
    await h.manager.closeAccount('A');
    // Resolved only after the CLI exited and the cut turn finished.
    expect(h.fake.calls[0]!.ended).toBe(true);
    expect(h.thread('t1').status).toBe('idle');
    const notices = logItems(h.threadLog).filter((i) => i.type === 'notice');
    expect(notices.map((n) => (n as { text: string }).text)).toContain('Interrupted: account A was removed.');
    // Other accounts' runners are untouched.
    await h.manager.closeAccount('B');
    expect(h.fake.calls).toHaveLength(1);
  });

  it('(3) abortAll kills a CLI that hangs while a deleted thread closes it', async () => {
    const accounts = accountsFor(['A']);
    let aborted = false;
    const { query } = scriptedQuery(async function* (options) {
      yield { type: 'system', subtype: 'init', session_id: SID, model: 'claude-fable-5' };
      // Never exits on close(); only the abort signal (process kill) ends it.
      await new Promise<void>((resolve) =>
        options.abortController!.signal.addEventListener('abort', () => {
          aborted = true;
          resolve();
        }),
      );
    });
    const manager = createSessionManager({
      query,
      store: createMemoryStore({ threads: [makeThread('t1', { cwd: join(root, 'work') })], accounts }),
      threadLog: createMemoryThreadLog(),
      listAccounts: () => accounts,
      usage: createMemoryUsagePoller(() => accounts),
      shellEnv: createStaticShellEnv(),
      claudeBinary: createStaticClaudeBinary(),
      broadcaster: createRecordingBroadcaster(),
      appVersion: '0.1.0',
      log: () => {},
    });
    await manager.send('t1', 'hi');
    let closed = false;
    const closing = manager.closeThread('t1').then(() => (closed = true));
    await new Promise((r) => setTimeout(r, 5));
    expect(closed).toBe(false);
    manager.abortAll();
    await closing;
    expect(aborted).toBe(true);
  });

  it('(5) chat:send reports auth when every enabled account needs a re-login', async () => {
    const h = setup({ accounts: ['A', 'B'] });
    for (const id of ['A', 'B']) h.usage.set(id, { fetchedAt: Date.now(), stale: true, error: 'auth' });
    expect(await h.manager.send('t1', 'hi')).toEqual({ accepted: false, reason: 'auth' });
    expect(h.thread('t1').status).toBe('idle');
    expect(h.fake.calls).toHaveLength(0);
  });

  it('(7) a partial flushed on a rate-limit cut is upserted by the late complete message (no duplicate)', async () => {
    const accounts = accountsFor(['A', 'B']);
    const fake = createFakeQuery({ scenario: () => [{ type: 'text', text: 'Retried on B.' }] });
    let calls = 0;
    const cut = scriptedQuery(async function* () {
      yield { type: 'system', subtype: 'init', session_id: SID, model: 'claude-fable-5' };
      yield {
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } },
      };
      yield { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour' } };
      // The runner flushes the partial meanwhile; then the CLI still delivers the block's complete message.
      await new Promise((r) => setTimeout(r, 5));
      yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] } };
      yield { type: 'result', subtype: 'error_during_execution', is_error: true };
    });
    const query = ((params: Parameters<QueryFn>[0]) => (calls++ === 0 ? cut.query(params) : fake.query(params))) as QueryFn;
    const threadLog = createMemoryThreadLog();
    const manager = createSessionManager({
      query,
      store: createMemoryStore({ threads: [makeThread('t1', { cwd: join(root, 'work') })], accounts }),
      threadLog,
      listAccounts: () => accounts,
      usage: createMemoryUsagePoller(() => accounts),
      shellEnv: createStaticShellEnv(),
      claudeBinary: createStaticClaudeBinary(),
      broadcaster: createRecordingBroadcaster(),
      appVersion: '0.1.0',
      log: () => {},
    });
    await manager.send('t1', 'hi');
    await until(() => fake.calls.length === 1);
    await manager.whenSettled('t1');
    const texts = logItems(threadLog).filter((i) => i.type === 'assistant-text') as { id: string; text: string }[];
    expect(texts.map((t) => t.text)).toEqual(['Hello', 'Retried on B.']);
    expect(new Set(texts.map((t) => t.id)).size).toBe(2);
  });
});
