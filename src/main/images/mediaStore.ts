// Agent images on disk (`<userData>/media/<threadId>/<sha256>.<ext>`, 0600 in 0700 folders). The thread log keeps
// only `{mediaType, data: '', ref}` so screenshots never bloat or leak through the JSONL; the renderer reads the
// file back with `image:read {threadId, ref}`. Content-addressed: re-appending the same item rewrites nothing.
import { createHash } from 'node:crypto';
import { readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MAX_AGENT_IMAGE_BYTES, toAgentImage } from '../../core/agentImages';
import { sniffMagic } from '../../core/attachments';
import type { ChatImage, ChatItem } from '../../shared/types';
import { PRIVATE_FILE_MODE, mkdirPrivate } from '../persistence/jsonl';
import { assertSafeId } from '../persistence/safeId';

const EXT_BY_TYPE: Readonly<Record<ChatImage['mediaType'], string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};
const TYPE_BY_EXT: Readonly<Record<string, ChatImage['mediaType']>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};
const REF_RE = /^([0-9a-f]{64})\.(png|jpg|gif|webp)$/;
/** Bytes of one thread's media folder; a write past it is refused (a looping agent cannot fill the disk). */
export const MAX_THREAD_MEDIA_BYTES = 500 * 1024 * 1024;

export class MediaRefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MediaRefError';
  }
}

export interface MediaStore {
  /** Writes `image` (validated again) and returns its ref. */
  put(threadId: string, image: ChatImage): Promise<string>;
  /** Bytes of `ref` (re-checked: ref format, size cap, magic bytes). */
  read(threadId: string, ref: unknown): Promise<{ mediaType: ChatImage['mediaType']; buffer: Buffer }>;
  /** Item with every inline agent image moved to the store (input untouched). Invalid images are dropped. */
  externalize(threadId: string, item: ChatItem): Promise<ChatItem>;
  /** Deletes the thread's media folder. */
  removeThread(threadId: string): Promise<void>;
}

export function isMediaRef(ref: unknown): ref is string {
  return typeof ref === 'string' && REF_RE.test(ref);
}

export function createMediaStore(
  dir: string,
  log: (message: string, err?: unknown) => void = () => {},
  opts: { maxThreadBytes?: number } = {},
): MediaStore {
  const maxThreadBytes = opts.maxThreadBytes ?? MAX_THREAD_MEDIA_BYTES;
  const threadDir = (threadId: string) => join(dir, assertSafeId(threadId, 'threadId'));
  /** Folder size per thread, measured once from disk and then kept up to date by put / removeThread. */
  const usage = new Map<string, number>();

  async function folderBytes(threadId: string): Promise<number> {
    const known = usage.get(threadId);
    if (known !== undefined) return known;
    const folder = threadDir(threadId);
    let total = 0;
    for (const name of await readdir(folder).catch(() => [] as string[])) {
      const st = await stat(join(folder, name)).catch(() => null);
      if (st?.isFile()) total += st.size;
    }
    usage.set(threadId, total);
    return total;
  }

  async function put(threadId: string, image: ChatImage): Promise<string> {
    const valid = toAgentImage(image.mediaType, image.data);
    if (!valid) throw new MediaRefError('not a displayable image');
    const buffer = Buffer.from(valid.data, 'base64');
    if (buffer.length > MAX_AGENT_IMAGE_BYTES) throw new MediaRefError('image too large');
    const ref = `${createHash('sha256').update(buffer).digest('hex')}.${EXT_BY_TYPE[valid.mediaType]}`;
    const folder = threadDir(threadId);
    const path = join(folder, ref);
    const exists = await stat(path).then(
      (st) => st.isFile() && st.size === buffer.length,
      () => false,
    );
    if (!exists) {
      const used = await folderBytes(threadId);
      if (used + buffer.length > maxThreadBytes) throw new MediaRefError('thread media folder full');
      await mkdirPrivate(folder);
      await writeFile(path, buffer, { mode: PRIVATE_FILE_MODE });
      usage.set(threadId, used + buffer.length);
    }
    return ref;
  }

  async function read(threadId: string, ref: unknown): Promise<{ mediaType: ChatImage['mediaType']; buffer: Buffer }> {
    const m = typeof ref === 'string' ? REF_RE.exec(ref) : null;
    if (!m) throw new MediaRefError('invalid media ref');
    const mediaType = TYPE_BY_EXT[m[2]!]!;
    const path = join(threadDir(threadId), m[0]);
    const st = await stat(path).catch(() => null);
    if (!st?.isFile()) throw new MediaRefError('image not found');
    if (st.size > MAX_AGENT_IMAGE_BYTES) throw new MediaRefError('image too large');
    const buffer = await readFile(path);
    if (sniffMagic(buffer.subarray(0, 16)) !== mediaType) throw new MediaRefError('not a displayable image');
    return { mediaType, buffer };
  }

  async function storeAll(threadId: string, images: readonly ChatImage[]): Promise<ChatImage[]> {
    const out: ChatImage[] = [];
    for (const image of images) {
      if (image.ref && !image.data) {
        out.push(image);
        continue;
      }
      try {
        out.push({ mediaType: image.mediaType, data: '', ref: await put(threadId, image) });
      } catch (err) {
        // Never fall back to base64 in the log: the image is left out.
        log('[media] image not stored', err);
      }
    }
    return out;
  }

  return {
    put,
    read,
    async externalize(threadId, item) {
      // User attachments too: no image is written into the log as base64 (older logs that have some still read).
      if ((item.type !== 'tool' && item.type !== 'assistant-text' && item.type !== 'user') || !item.images || item.images.length === 0) return item;
      if (item.images.every((image) => image.ref && !image.data)) return item;
      const images = await storeAll(threadId, item.images);
      const { images: _inline, ...rest } = item;
      return (images.length > 0 ? { ...rest, images } : rest) as ChatItem;
    },
    async removeThread(threadId) {
      await rm(threadDir(threadId), { recursive: true, force: true });
      usage.delete(threadId);
    },
  };
}
