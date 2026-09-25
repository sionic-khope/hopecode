// `threads/<threadId>.jsonl` ChatItem append/read (plan 3.2 / 4.2 persistence/threadLog.ts).
// Re-appending an item with an existing id is an upsert: `read()` returns one entry per id,
// keeping first-seen position but the latest appended content.
// Appends of one thread are serialized through a promise chain so upserts land in call order (M5).
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChatItem } from '../../shared/types';
import type { ThreadLog } from '../contracts';
import { appendJsonl, readAllJsonl } from './jsonl';
import { assertSafeId } from './safeId';

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT';
}

export function createThreadLog(dir: string): ThreadLog {
  const fileFor = (threadId: string): string => join(dir, `${assertSafeId(threadId, 'threadId')}.jsonl`);
  const chains = new Map<string, Promise<void>>();

  /** Run `op` after every earlier queued op of the thread (failures do not break the chain). */
  function enqueue(threadId: string, op: () => Promise<void>): Promise<void> {
    const prev = chains.get(threadId) ?? Promise.resolve();
    const next = prev.then(op, op);
    const tail = next.catch(() => {});
    chains.set(threadId, tail);
    void tail.then(() => {
      if (chains.get(threadId) === tail) chains.delete(threadId);
    });
    return next;
  }

  return {
    async append(threadId, item) {
      const file = fileFor(threadId);
      return enqueue(threadId, () => appendJsonl(file, item));
    },
    async read(threadId) {
      const file = fileFor(threadId);
      // Wait for queued appends so a read right after an append sees it.
      await chains.get(threadId);
      const items = await readAllJsonl<ChatItem>(file);
      const byId = new Map<string, ChatItem>();
      for (const item of items) byId.set(item.id, item);
      return [...byId.values()];
    },
    async remove(threadId) {
      const file = fileFor(threadId);
      return enqueue(threadId, async () => {
        try {
          await rm(file);
        } catch (err) {
          if (!isEnoent(err)) throw err;
        }
      });
    },
  };
}
