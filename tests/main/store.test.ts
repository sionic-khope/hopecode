import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../../src/main/persistence/store';
import { DEFAULT_SETTINGS } from '../../src/shared/constants';
import type { PersistedState, Thread } from '../../src/shared/types';

function makeThread(overrides: Partial<Thread> = {}): Thread {
  const now = Date.now();
  return {
    id: 't1',
    projectId: 'p1',
    title: 'Test',
    cwd: '/tmp/project',
    model: 'default',
    resolvedModel: null,
    permissionMode: 'default',
    effort: null,
    pinnedAccountId: null,
    pinned: false,
    archived: false,
    lastAccountId: null,
    activeAccountId: null,
    sdkSessionId: null,
    status: 'idle',
    waitingUntil: null,
    pendingPrompt: null,
    sessionStartedAt: null,
    ctxPercent: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('store', () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hopecode-store-'));
    filePath = join(dir, 'state.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('load() creates a default state when the file is missing', async () => {
    const store = createStore(filePath);
    const state = await store.load();
    expect(state).toEqual({
      version: 1,
      projects: [],
      threads: [],
      accounts: [],
      settings: DEFAULT_SETTINGS,
    });
  });

  it('load() recovers from a corrupt file instead of throwing', async () => {
    await writeFile(filePath, '{ this is not valid json', 'utf8');
    const store = createStore(filePath);
    const state = await store.load();
    expect(state.threads).toEqual([]);
    expect(state.settings).toEqual(DEFAULT_SETTINGS);
  });

  it('load() normalizes running threads to idle and drops their pending/waiting state', async () => {
    const persisted: PersistedState = {
      version: 1,
      projects: [],
      threads: [makeThread({ status: 'running', pendingPrompt: { text: 'hi', kind: 'original' }, waitingUntil: 123 })],
      accounts: [],
      settings: DEFAULT_SETTINGS,
    };
    await writeFile(filePath, JSON.stringify(persisted), 'utf8');
    const store = createStore(filePath);
    const state = await store.load();
    expect(state.threads[0]?.status).toBe('idle');
    expect(state.threads[0]?.pendingPrompt).toBeNull();
    expect(state.threads[0]?.waitingUntil).toBeNull();
  });

  it('flush() writes atomically and leaves no temp file behind', async () => {
    const store = createStore(filePath);
    await store.load();
    store.update((draft) => {
      draft.threads.push(makeThread());
    });
    await store.flush();

    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as PersistedState;
    expect(parsed.threads).toHaveLength(1);

    const leftovers = (await readdir(dir)).filter((name) => name.includes('.tmp-'));
    expect(leftovers).toEqual([]);
  });

  it('debounces saves within a 250ms window', async () => {
    const store = createStore(filePath);
    await store.load();

    store.update((draft) => {
      draft.threads.push(makeThread({ id: 'a' }));
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    store.update((draft) => {
      draft.threads.push(makeThread({ id: 'b' }));
    });

    // Still inside the debounce window restarted by the second update.
    await new Promise((resolve) => setTimeout(resolve, 100));
    await expect(readFile(filePath, 'utf8')).rejects.toThrow();

    await new Promise((resolve) => setTimeout(resolve, 250));
    const raw = await readFile(filePath, 'utf8');
    expect((JSON.parse(raw) as PersistedState).threads).toHaveLength(2);
  }, 10_000);

  it('patchThread() shallow-merges, bumps updatedAt, and throws for a missing thread', async () => {
    const store = createStore(filePath);
    await store.load();
    store.update((draft) => {
      draft.threads.push(makeThread({ id: 'x', title: 'old' }));
    });
    const before = store.getThread('x')?.updatedAt ?? 0;

    await new Promise((resolve) => setTimeout(resolve, 2));
    const patched = store.patchThread('x', { title: 'new' });
    expect(patched.title).toBe('new');
    expect(patched.updatedAt).toBeGreaterThanOrEqual(before);
    expect(() => store.patchThread('missing', { title: 'x' })).toThrow();
  });

  it('onChange() notifies subscribers until unsubscribed', async () => {
    const store = createStore(filePath);
    await store.load();
    const seen: number[] = [];
    const unsubscribe = store.onChange((state) => seen.push(state.threads.length));

    store.update((draft) => {
      draft.threads.push(makeThread({ id: 'a' }));
    });
    unsubscribe();
    store.update((draft) => {
      draft.threads.push(makeThread({ id: 'b' }));
    });

    expect(seen).toEqual([1]);
  });
  it('load() gives threads saved before pinned / archived / effort their defaults', async () => {
    const legacy = makeThread({ id: 'old' }) as Partial<Thread>;
    delete legacy.pinned;
    delete legacy.archived;
    delete legacy.effort;
    const odd = { ...makeThread({ id: 'odd' }), pinned: 'yes', archived: 1, effort: 'extreme' };
    await writeFile(
      filePath,
      JSON.stringify({ version: 1, projects: [], threads: [legacy, odd], accounts: [], settings: DEFAULT_SETTINGS }),
      'utf8',
    );
    const state = await createStore(filePath).load();
    for (const t of state.threads) {
      expect(t).toMatchObject({ pinned: false, archived: false, effort: null });
    }
  });

  it('pinned / archived / effort survive a save and reload', async () => {
    const store = createStore(filePath);
    await store.load();
    store.update((draft) => {
      draft.threads.push(makeThread({ id: 'a' }), makeThread({ id: 'b' }));
    });
    store.patchThread('a', { pinned: true, effort: 'xhigh' });
    store.patchThread('b', { archived: true });
    await store.flush();

    const reloaded = await createStore(filePath).load();
    expect(reloaded.threads.map((t) => [t.id, t.pinned, t.archived, t.effort])).toEqual([
      ['a', true, false, 'xhigh'],
      ['b', false, true, null],
    ]);
  });
});
