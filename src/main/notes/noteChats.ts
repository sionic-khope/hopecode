// Per-note AI conversations (requests, whole answers and what the user did with each card), kept in the app data folder (never in the vault): one JSON file per
// (vault, note path), named by a hash so no user path becomes a file name.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { NoteCardMark, NoteChatItem } from '../../shared/notes';
import { atomicWrite } from './vaultFs';

/** Rows kept per note (oldest dropped first). */
export const NOTE_CHAT_MAX_ITEMS = 200;
/** Characters kept of one row (a whole answer with its cards). */
export const NOTE_CHAT_TEXT_MAX = 60_000;
/** Cards tracked per row. */
const CARDS_MAX = 50;
/** Characters of the revert data kept with an applied card (larger ones keep the state only). */
export const NOTE_CARD_REVERT_MAX = 200_000;

export interface NoteChats {
  list(vault: string, path: string): Promise<NoteChatItem[]>;
  append(vault: string, path: string, item: Omit<NoteChatItem, 'id' | 'createdAt'>): Promise<NoteChatItem>;
  /** Records what the user did with card `card` of row `id` (null clears it). False when the row is gone. */
  markCard(vault: string, path: string, id: string, card: number, mark: NoteCardMark | null): Promise<boolean>;
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
        const row: NoteChatItem = { ...item, text: item.text.slice(0, NOTE_CHAT_TEXT_MAX), id: randomUUID(), createdAt: now() };
        const items = [...(await read(file)), row].slice(-NOTE_CHAT_MAX_ITEMS);
        await mkdir(dir, { recursive: true, mode: 0o700 });
        await atomicWrite(file, JSON.stringify({ vault, path, items }));
        return row;
      });
    },
    markCard(vault, path, id, card, mark) {
      const file = fileFor(vault, path);
      return serial(file, async () => {
        const items = await read(file);
        const row = items.find((it) => it.id === id && it.role === 'assistant');
        if (!row) return false;
        const cards = { ...(row.cards ?? {}) };
        if (mark === null) delete cards[String(card)];
        else {
          const size = (mark.inserted?.length ?? 0) + (mark.original?.length ?? 0);
          cards[String(card)] = size > NOTE_CARD_REVERT_MAX ? { state: mark.state } : mark;
        }
        const keys = Object.keys(cards);
        if (keys.length > CARDS_MAX) for (const k of keys.slice(0, keys.length - CARDS_MAX)) delete cards[k];
        row.cards = cards;
        await atomicWrite(file, JSON.stringify({ vault, path, items }));
        return true;
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
