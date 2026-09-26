// First user message of each thread, for ⌘K thread search (title + first message). A thread's first message never
// changes once written, so found entries are cached for the app's lifetime.
import type { ThreadLog } from '../contracts';

/** Search only needs the start of the message. */
export const FIRST_MESSAGE_MAX = 500;

export interface ThreadSearchIndex {
  firstMessages(threadIds: readonly string[]): Promise<Record<string, string>>;
}

export function createThreadSearchIndex(threadLog: Pick<ThreadLog, 'read'>): ThreadSearchIndex {
  const cache = new Map<string, string>();
  return {
    async firstMessages(threadIds) {
      const out: Record<string, string> = {};
      for (const id of threadIds) {
        let text = cache.get(id);
        if (text === undefined) {
          const items = await threadLog.read(id).catch(() => []);
          const first = items.find((i) => i.type === 'user');
          if (!first || first.type !== 'user') continue;
          text = first.text.slice(0, FIRST_MESSAGE_MAX);
          cache.set(id, text);
        }
        out[id] = text;
      }
      return out;
    },
  };
}
