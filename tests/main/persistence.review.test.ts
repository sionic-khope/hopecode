// Persistence review fixes: thread log ordering (M5), safe ids (M2), store write safety (M6), file modes (L7),
// interrupted-thread report (L3), project trust migration.
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { restrictPrivateModes } from '../../src/main/persistence/jsonl';
import { createStore } from '../../src/main/persistence/store';
import { createThreadLog } from '../../src/main/persistence/threadLog';
import { createUsageHistory } from '../../src/main/persistence/usageHistory';
import { makeThread } from '../../src/main/fixtures/memoryDeps';
import type { ChatItem, PersistedState } from '../../src/shared/types';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hopecode-persist-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

const text = (id: string, t: string): ChatItem => ({ type: 'assistant-text', id, text: t, createdAt: 0 });
const mode = async (p: string): Promise<number> => (await stat(p)).mode & 0o777;

describe('threadLog', () => {
  it('(M5) concurrent appends of one thread land in call order (last upsert wins)', async () => {
    const log = createThreadLog(join(dir, 'threads'));
    const writes: Promise<void>[] = [];
    for (let i = 0; i < 50; i++) writes.push(log.append('t1', text('same', `v${i}`)));
    writes.push(log.append('t1', text('other', 'x')));
    await Promise.all(writes);
    const items = await log.read('t1');
    expect(items.map((i) => (i as { text: string }).text)).toEqual(['v49', 'x']);
    const raw = (await readFile(join(dir, 'threads', 't1.jsonl'), 'utf8')).trim().split('\n');
    expect(raw.map((l) => (JSON.parse(l) as { text: string }).text)).toEqual([
      ...Array.from({ length: 50 }, (_, i) => `v${i}`),
      'x',
    ]);
  });

  it('(M2) rejects ids that could escape the directory', async () => {
    const log = createThreadLog(join(dir, 'threads'));
    await expect(log.append('../evil', text('a', 'x'))).rejects.toThrow(/invalid threadId/);
    await expect(log.read('a/b')).rejects.toThrow(/invalid threadId/);
    await expect(log.remove('')).rejects.toThrow(/invalid threadId/);
    const history = createUsageHistory(join(dir, 'usage'));
    await expect(history.read('../../x', 1000)).rejects.toThrow(/invalid accountId/);
  });

  it('(L7) log files are 0600 and their directory 0700', async () => {
    const log = createThreadLog(join(dir, 'threads'));
    await log.append('t1', text('a', 'x'));
    expect(await mode(join(dir, 'threads', 't1.jsonl'))).toBe(0o600);
    expect(await mode(join(dir, 'threads'))).toBe(0o700);
  });
});

describe('(review 11) startup permission repair', () => {
  it('tightens existing state / jsonl files to 0600 and their directories to 0700', async () => {
    await mkdir(join(dir, 'threads'), { mode: 0o755 });
    await mkdir(join(dir, 'usage'), { mode: 0o755 });
    await writeFile(join(dir, 'state.json'), '{}', { mode: 0o644 });
    await writeFile(join(dir, 'threads', 't1.jsonl'), '', { mode: 0o644 });
    await writeFile(join(dir, 'usage', 'a.jsonl'), '', { mode: 0o644 });
    await writeFile(join(dir, 'other.txt'), '', { mode: 0o644 });
    await chmod(dir, 0o755);

    await restrictPrivateModes(dir, ['threads', 'usage', 'missing']);

    expect(await mode(dir)).toBe(0o700);
    expect(await mode(join(dir, 'threads'))).toBe(0o700);
    expect(await mode(join(dir, 'usage'))).toBe(0o700);
    expect(await mode(join(dir, 'state.json'))).toBe(0o600);
    expect(await mode(join(dir, 'threads', 't1.jsonl'))).toBe(0o600);
    expect(await mode(join(dir, 'usage', 'a.jsonl'))).toBe(0o600);
    // Unrelated files are left alone.
    expect(await mode(join(dir, 'other.txt'))).toBe(0o644);
  });
});

describe('store', () => {
  it('(review 9) an unreadable state.json aborts load() and is never replaced by defaults', async () => {
    const file = join(dir, 'state.json');
    const original = JSON.stringify({ version: 1, projects: [], threads: [makeThread('keep')], accounts: [], settings: {} });
    await writeFile(file, original, 'utf8');
    await chmod(file, 0o000);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = createStore(file, { now: () => 99 });
    try {
      await expect(store.load()).rejects.toThrow(/did not start/);
      await store.flush();
    } finally {
      await chmod(file, 0o600);
    }
    expect(await readFile(file, 'utf8')).toBe(original);
  });

  it('(M6) a corrupt state.json is backed up before defaults are used', async () => {
    const file = join(dir, 'state.json');
    await writeFile(file, '{ not json', 'utf8');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = createStore(file, { now: () => 1234 });
    const state = await store.load();
    expect(state.projects).toEqual([]);
    expect(await readFile(join(dir, 'state.json.corrupt-1234'), 'utf8')).toBe('{ not json');
  });

  it('(M6) overlapping flushes are serialized, leave no temp files and end with the latest state (0600)', async () => {
    const file = join(dir, 'state.json');
    const store = createStore(file);
    await store.load();
    const flushes: Promise<void>[] = [];
    for (let i = 0; i < 20; i++) {
      store.update((d) => {
        d.threads.push(makeThread(`t${i}`));
      });
      flushes.push(store.flush());
    }
    await Promise.all(flushes);
    await store.flush();
    const parsed = JSON.parse(await readFile(file, 'utf8')) as PersistedState;
    expect(parsed.threads).toHaveLength(20);
    expect((await readdir(dir)).filter((n) => n.includes('.tmp-'))).toEqual([]);
    expect(await mode(file)).toBe(0o600);
  });

  it('(L3) reports threads that were running at the last exit; (trust) old projects load untrusted', async () => {
    const file = join(dir, 'state.json');
    const persisted = {
      version: 1,
      projects: [{ id: 'p1', name: 'p', path: '/p', createdAt: 0 }],
      threads: [makeThread('run', { status: 'running' }), makeThread('idle')],
      accounts: [],
      settings: {},
    };
    await writeFile(file, JSON.stringify(persisted), 'utf8');
    const onInterrupted = vi.fn();
    const state = await createStore(file, { onInterrupted }).load();
    expect(onInterrupted).toHaveBeenCalledWith(['run']);
    expect(state.threads.find((t) => t.id === 'run')?.status).toBe('idle');
    expect(state.projects[0]).toMatchObject({ id: 'p1', trusted: false });
  });
});
