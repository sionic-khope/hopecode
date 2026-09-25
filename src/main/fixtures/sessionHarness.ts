// SessionManager wired to in-memory deps + scripted fakeQuery (2A tests, fixture experiments).
import { basename } from 'node:path';
import type { Account, AppSettings, Thread } from '../../shared/types';
import { createSessionManager, type SessionManagerImpl } from '../session/sessionManager';
import { syncTranscript, type SyncTranscriptFn } from '../session/transcriptSync';
import { createFakeQuery, type FakeQueryController, type FakeQueryOptions } from './fakeQuery';
import {
  createMemoryStore,
  createMemoryThreadLog,
  createMemoryUsagePoller,
  createRecordingBroadcaster,
  createStaticClaudeBinary,
  createStaticShellEnv,
  type MemoryThreadLog,
  type MemoryUsagePoller,
  type RecordingBroadcaster,
} from './memoryDeps';
import type { Store } from '../contracts';

export interface SessionHarnessOptions extends FakeQueryOptions {
  accounts: Account[];
  threads: Thread[];
  settings?: Partial<AppSettings>;
  appVersion?: string;
}

export interface SessionHarness {
  manager: SessionManagerImpl;
  fake: FakeQueryController;
  store: Store;
  usage: MemoryUsagePoller;
  broadcaster: RecordingBroadcaster;
  threadLog: MemoryThreadLog;
  accounts: Account[];
  /** Every transcript sync call; also recorded in fake.timeline as `sync:<fromBase>-><toBase>`. */
  syncs: { sessionId: string; from: string; to: string; found: boolean }[];
  thread(id: string): Thread;
}

export function createSessionHarness(opts: SessionHarnessOptions): SessionHarness {
  const accounts = opts.accounts;
  const store = createMemoryStore({ threads: opts.threads, accounts, settings: opts.settings as AppSettings | undefined });
  const usage = createMemoryUsagePoller(() => accounts);
  const broadcaster = createRecordingBroadcaster();
  const threadLog = createMemoryThreadLog();
  const fake = createFakeQuery(opts);
  const syncs: SessionHarness['syncs'] = [];

  const recordingSync: SyncTranscriptFn = async (sessionId, from, to) => {
    fake.timeline.push(`sync:${basename(from)}->${basename(to)}`);
    const result = await syncTranscript(sessionId, from, to);
    syncs.push({ sessionId, from, to, found: result.found });
    return result;
  };

  const manager = createSessionManager({
    query: fake.query,
    store,
    threadLog,
    listAccounts: () => accounts,
    usage,
    shellEnv: createStaticShellEnv(),
    claudeBinary: createStaticClaudeBinary(),
    broadcaster,
    appVersion: opts.appVersion ?? '0.1.0',
    syncTranscript: recordingSync,
    log: () => {},
  });

  return {
    manager,
    fake,
    store,
    usage,
    broadcaster,
    threadLog,
    accounts,
    syncs,
    thread(id) {
      const t = store.getThread(id);
      if (!t) throw new Error(`thread not found: ${id}`);
      return t;
    },
  };
}
