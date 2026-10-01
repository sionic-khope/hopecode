// Per-note AI conversation summaries, kept in the app data folder (never in the vault): one JSON file per
// (vault, note path), named by a hash so no user path becomes a file name.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { NoteChatItem } from '../../shared/notes';
import { atomicWrite } from './vaultFs';

/** Rows kept per note (oldest dropped first). */
export const NOTE_CHAT_MAX_ITEMS = 200;
const TEXT_MAX = 4_000;

export interface NoteChats {
  list(vault: string, path: string): Promise<NoteChatItem[]>;
  append(vault: string, path: string, item: Omit<NoteChatItem, 'id' | 'createdAt'>): Promise<NoteChatItem>;
  /** A note was renamed / moved: its conversation follows it. */
  move(vault: string, from: string, to: string): Promise<void>;
}

export function createNoteChats(dir: string, now: () => number = Date.now): NoteChats {
  const fileFor = (vault: string, path: string) =>
    join(dir, `${createHash('sha256').update(`${vault}\0${path}`).digest('hex').slice(0, 40)}.json`);
  // Appends per file are serialized so two quick runs never drop a row.
  const queues = new Map<string, Promise<unknown>>();

  async function read(file: string): Promise<NoteChatItem[]> {
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as { items?: unknown };
      return Array.isArray(parsed.items) ? (parsed.items as NoteChatItem[]) : [];
    } catch {
      return [];
    }
  }

  function serial<T>(file: string, task: () => Promise<T>): Promise<T> {
    const prev = queues.get(file) ?? Promise.resolve();
    const next = prev.then(task, task);
    queues.set(
      file,
      next.catch(() => {}),
    );
    return next;
  }

  return {
    list: (vault, path) => read(fileFor(vault, path)),
    append(vault, path, item) {
      const file = fileFor(vault, path);
      return serial(file, async () => {
        const row: NoteChatItem = { ...item, text: item.text.slice(0, TEXT_MAX), id: randomUUID(), createdAt: now() };
        const items = [...(await read(file)), row].slice(-NOTE_CHAT_MAX_ITEMS);
        await mkdir(dir, { recursive: true, mode: 0o700 });
        await atomicWrite(file, JSON.stringify({ vault, path, items }));
        return row;
      });
    },
    async move(vault, from, to) {
      const src = fileFor(vault, from);
      await serial(src, async () => {
        await rename(src, fileFor(vault, to)).catch(() => {});
      });
    },
  };
}
