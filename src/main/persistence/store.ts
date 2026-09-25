// `state.json` load/migrate/save (plan 3.2 / 4.2 persistence/store.ts).
// Atomic replace (unique tmp + fsync + rename), writes serialized, 250ms debounced save,
// `running` -> `idle` normalization on load, corrupt file backed up before resetting (M6); an unreadable
// (non-ENOENT) file aborts load() instead of being replaced by defaults.
import { randomUUID } from 'node:crypto';
import { copyFile, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DEFAULT_SETTINGS, EFFORT_LEVELS } from '../../shared/constants';
import type { EffortLevel, PersistedState, Thread } from '../../shared/types';
import type { Store, Unsubscribe } from '../contracts';
import { PRIVATE_FILE_MODE, mkdirPrivate } from './jsonl';

const SAVE_DEBOUNCE_MS = 250;

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT';
}

function defaultState(): PersistedState {
  return { version: 1, projects: [], threads: [], accounts: [], settings: { ...DEFAULT_SETTINGS } };
}

/** Fields added after the first release (pinned / archived / effort) get their defaults. */
function migrateThread(raw: Thread): Thread {
  const t = raw as Partial<Thread> & Thread;
  const effort = (EFFORT_LEVELS as readonly unknown[]).includes(t.effort) ? (t.effort as EffortLevel) : null;
  return { ...t, pinned: t.pinned === true, archived: t.archived === true, effort };
}

/** Best-effort migration: unknown/missing fields fall back to defaults rather than throwing. */
function migrate(raw: unknown): PersistedState {
  if (!raw || typeof raw !== 'object') return defaultState();
  const obj = raw as Partial<PersistedState>;
  return {
    version: 1,
    // `trusted` was added later: projects saved before it are untrusted until the user confirms.
    projects: Array.isArray(obj.projects) ? obj.projects.map((p) => ({ ...p, trusted: p.trusted === true })) : [],
    threads: Array.isArray(obj.threads) ? obj.threads.map(migrateThread) : [],
    accounts: Array.isArray(obj.accounts) ? obj.accounts : [],
    settings: { ...DEFAULT_SETTINGS, ...(obj.settings ?? {}) },
  };
}

/** App-quit interruption is not resumable state; clear it and let the UI show a notice. Returns the thread ids. */
function normalizeRunningThreads(threads: Thread[]): string[] {
  const interrupted: string[] = [];
  for (const thread of threads) {
    if (thread.status === 'running') {
      thread.status = 'idle';
      thread.pendingPrompt = null;
      thread.waitingUntil = null;
      interrupted.push(thread.id);
    }
  }
  return interrupted;
}

export interface StoreOptions {
  /** Threads that were `running` when the app last exited (normalized to idle by load()). */
  onInterrupted?: (threadIds: string[]) => void;
  now?: () => number;
}

export function createStore(filePath: string, opts: StoreOptions = {}): Store {
  const now = opts.now ?? Date.now;
  let state: PersistedState = defaultState();
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** Tail of the serialized write chain. */
  let writing: Promise<void> = Promise.resolve();
  const listeners = new Set<(state: PersistedState) => void>();

  function notify(): void {
    for (const cb of listeners) cb(state);
  }

  async function writeOnce(): Promise<void> {
    await mkdirPrivate(dirname(filePath));
    const tmp = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
    const data = JSON.stringify(state, null, 2);
    try {
      const fh = await open(tmp, 'w', PRIVATE_FILE_MODE);
      try {
        await fh.writeFile(data, 'utf8');
        await fh.sync();
      } finally {
        await fh.close();
      }
      await rename(tmp, filePath);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  }

  /** Queue a write after any in-flight one (a write snapshots the state when it starts). */
  function writeAtomic(): Promise<void> {
    const next = writing.then(writeOnce, writeOnce);
    writing = next.catch(() => {});
    return next;
  }

  function scheduleSave(): void {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      writeAtomic().catch((err: unknown) => console.error('[store] save failed', err));
    }, SAVE_DEBOUNCE_MS);
  }

  async function backupCorrupt(): Promise<void> {
    const backup = `${filePath}.corrupt-${now()}`;
    try {
      await copyFile(filePath, backup);
      console.error(`[store] state.json could not be parsed; backed up to ${backup}`);
    } catch (err) {
      console.error('[store] failed to back up corrupt state.json', err);
    }
  }

  /** Best-effort copy of a state.json that exists but could not be read (the copy may fail the same way). */
  async function backupUnreadable(): Promise<void> {
    const backup = `${filePath}.unreadable-${now()}`;
    try {
      await copyFile(filePath, backup);
      console.error(`[store] state.json could not be read; backed up to ${backup}`);
    } catch (err) {
      console.error('[store] failed to back up unreadable state.json', err);
    }
  }

  return {
    async load() {
      let raw: string | null = null;
      try {
        raw = await readFile(filePath, 'utf8');
      } catch (err) {
        // Missing file (first run): empty, valid state. Any other read error (EACCES, EIO, EISDIR...) must not
        // be answered with defaults: the next save would overwrite the user's data. Back up and refuse to start.
        if (!isEnoent(err)) {
          await backupUnreadable();
          const code = (err as { code?: string }).code ?? 'unknown error';
          throw new Error(
            `Could not read ${filePath} (${code}). Hopecode did not start so your saved data is not overwritten. Fix the file's permissions and restart.`,
            { cause: err },
          );
        }
      }
      state = defaultState();
      if (raw !== null) {
        try {
          state = migrate(JSON.parse(raw));
        } catch {
          // Keep the unreadable file so the user's data is not lost on the next save.
          await backupCorrupt();
        }
      }
      const interrupted = normalizeRunningThreads(state.threads);
      if (interrupted.length > 0) opts.onInterrupted?.(interrupted);
      notify();
      return state;
    },
    get() {
      return state;
    },
    update(mutator) {
      mutator(state);
      notify();
      scheduleSave();
    },
    getThread(threadId) {
      return state.threads.find((t) => t.id === threadId);
    },
    patchThread(threadId, patch) {
      const thread = state.threads.find((t) => t.id === threadId);
      if (!thread) throw new Error(`thread not found: ${threadId}`);
      Object.assign(thread, patch, { updatedAt: Date.now() });
      notify();
      scheduleSave();
      return thread;
    },
    async flush() {
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
        await writeAtomic();
        return;
      }
      await writing;
    },
    onChange(cb): Unsubscribe {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
