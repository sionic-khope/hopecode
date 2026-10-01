// Security review M2: a waiting prompt's attachment content stays in the runner's memory. state.json and
// `thread:updated` carry metadata only, and a resume whose content was lost (restart) refuses to send without it.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeAccount, makeThread } from '../../src/main/fixtures/memoryDeps';
import { createSessionHarness } from '../../src/main/fixtures/sessionHarness';
import { toPublicThread } from '../../src/main/persistence/publicThread';
import { createStore } from '../../src/main/persistence/store';
import { MINUTE_MS, WAIT_TICK_MS } from '../../src/shared/constants';
import type { PendingPrompt, Thread } from '../../src/shared/types';

const T0 = Date.parse('2026-09-25T12:00:00.000Z');
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const SECRET_TEXT = 'TOP-SECRET-FILE-BODY';
const SECRET_PATH = '/Users/someone/private/notes.md';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

function waitingHarness(thread: Partial<Thread> = {}) {
  const h = createSessionHarness({
    accounts: [makeAccount('A')],
    threads: [makeThread('t1', thread)],
    scenario: ({ prompt }) => [{ type: 'text', text: `re: ${prompt}` }],
  });
  h.usage.set('A', { fiveHour: { percent: 100, resetsAt: T0 + 30 * MINUTE_MS }, fetchedAt: T0, stale: false });
  return h;
}

describe('pending prompt attachments (memory only)', () => {
  it('a waiting prompt keeps metadata only in the thread and broadcasts; the resume still sends the content', async () => {
    const h = waitingHarness();
    const file = { kind: 'text' as const, name: 'notes.md', mediaType: 'text/markdown', size: SECRET_TEXT.length, data: SECRET_TEXT, path: SECRET_PATH };
    expect(await h.manager.send('t1', 'look', [{ mediaType: 'image/png', data: PNG_1X1 }], [file])).toEqual({ accepted: true, reason: 'waiting' });

    const pending = h.thread('t1').pendingPrompt!;
    expect(pending).toEqual({
      text: 'look',
      kind: 'original',
      attachments: [
        { kind: 'image', name: '이미지 1', mediaType: 'image/png', size: expect.any(Number) },
        { kind: 'text', name: 'notes.md', mediaType: 'text/markdown', size: SECRET_TEXT.length },
      ],
    });
    const serialized = JSON.stringify(pending);
    for (const leak of [SECRET_TEXT, SECRET_PATH, PNG_1X1, '"data"', '"path"']) expect(serialized).not.toContain(leak);
    const broadcasts = JSON.stringify(h.broadcaster.of('thread:updated'));
    for (const leak of [SECRET_TEXT, SECRET_PATH, PNG_1X1]) expect(broadcasts).not.toContain(leak);

    h.usage.set('A', { fiveHour: { percent: 10, resetsAt: null }, fetchedAt: T0, stale: false });
    vi.setSystemTime(T0 + 31 * MINUTE_MS);
    await vi.advanceTimersByTimeAsync(WAIT_TICK_MS);
    await h.manager.whenSettled('t1');
    expect(h.fake.calls).toHaveLength(1);
    expect(h.fake.calls[0]!.promptBlocks).toEqual([['image:image/png', 'document:text:text/plain', 'text']]);
    expect(h.thread('t1').status).toBe('idle');
  });

  it('after a restart (content gone) the resume fails with a notice instead of sending without the attachments', async () => {
    const h = waitingHarness({
      status: 'waiting',
      waitingUntil: T0 - MINUTE_MS,
      pendingPrompt: { text: 'queued', kind: 'original', attachments: [{ kind: 'pdf', name: 'spec.pdf', mediaType: 'application/pdf', size: 10 }] },
    });
    h.usage.set('A', { fiveHour: { percent: 10, resetsAt: null }, fetchedAt: T0, stale: false });
    h.manager.restore();
    await vi.advanceTimersByTimeAsync(0);
    await h.manager.whenSettled('t1');
    expect(h.fake.calls).toHaveLength(0);
    const t = h.thread('t1');
    expect(t.status).toBe('error');
    expect(t.pendingPrompt).toBeNull();
    const notices = (await h.threadLog.read('t1')).filter((i) => i.type === 'notice');
    expect(notices.at(-1)).toMatchObject({ level: 'error', text: expect.stringContaining('첨부를 다시 올려 주세요') });
  });
});

describe('toPublicThread / state.json', () => {
  const legacy = {
    text: 'old',
    kind: 'original',
    images: [{ mediaType: 'image/png', data: PNG_1X1 }],
    files: [{ kind: 'text', name: 'notes.md', mediaType: 'text/markdown', size: 3, data: SECRET_TEXT, path: SECRET_PATH }],
  } as unknown as PendingPrompt;

  it('reduces a (legacy) pending prompt with content to metadata', () => {
    const t = toPublicThread(makeThread('t1', { pendingPrompt: legacy }));
    expect(t.pendingPrompt).toEqual({
      text: 'old',
      kind: 'original',
      attachments: [
        { kind: 'image', name: '이미지 1', mediaType: 'image/png', size: expect.any(Number) },
        { kind: 'text', name: 'notes.md', mediaType: 'text/markdown', size: 3 },
      ],
    });
    expect(JSON.stringify(t)).not.toContain(SECRET_TEXT);
  });

  it('the store never writes attachment content or paths to disk', async () => {
    vi.useRealTimers();
    const dir = await mkdtemp(join(tmpdir(), 'hopecode-pending-'));
    try {
      const filePath = join(dir, 'state.json');
      const store = createStore(filePath);
      await store.load();
      store.update((draft) => {
        draft.threads.push(makeThread('t1', { status: 'waiting', pendingPrompt: legacy }));
      });
      await store.flush();
      const raw = await readFile(filePath, 'utf8');
      for (const leak of [SECRET_TEXT, SECRET_PATH, PNG_1X1]) expect(raw).not.toContain(leak);
      expect(JSON.parse(raw).threads[0].pendingPrompt.attachments).toHaveLength(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
