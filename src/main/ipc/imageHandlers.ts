// `image:*` invoke handlers (inline images, turn-end galleries, lightbox actions) + chat image validation.
// Paths come from the renderer: every one is resolved inside the thread's own folder (imageFiles.resolveThreadImage).
import { basename, extname } from 'node:path';
import type { InvokeResponse } from '../../shared/ipc';
import type { ChatImage, Thread } from '../../shared/types';
import { MAX_IMAGE_BYTES, readThreadImage, readThreadImageDataUrl, resolveThreadImage } from '../images/imageFiles';
import type { MediaStore } from '../images/mediaStore';
import { assertReq, isNonEmptyString, isPlainObject } from './guards';

/** Native side of the lightbox buttons (Electron shell / clipboard), injected so this module stays Node-only. */
export interface ImageActions {
  /** Reveals the file in Finder (a no-op in headless e2e). */
  reveal(absPath: string): Promise<void> | void;
  /** Puts an encoded PNG / JPEG / GIF / WebP image on the clipboard. */
  copy(buffer: Buffer): Promise<void> | void;
  /** Save dialog (default `name`) + write; false when cancelled. Test runs write into the exports folder. */
  save(buffer: Buffer, name: string): Promise<boolean>;
}

const CHAT_IMAGE_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
/** Composer attachments per message, and the API's 5 MB per-image limit (base64 length). */
export const MAX_CHAT_IMAGES = 8;
export const MAX_CHAT_IMAGE_BASE64 = Math.ceil((5 * 1024 * 1024 * 4) / 3);
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export function isChatImage(v: unknown, maxBase64: number = MAX_CHAT_IMAGE_BASE64): v is ChatImage {
  if (!isPlainObject(v)) return false;
  const { mediaType, data } = v as Record<string, unknown>;
  return (
    typeof mediaType === 'string' &&
    CHAT_IMAGE_TYPES.has(mediaType) &&
    typeof data === 'string' &&
    data.length > 0 &&
    data.length <= maxBase64 &&
    BASE64.test(data)
  );
}

export function isChatImageList(v: unknown): v is ChatImage[] {
  return Array.isArray(v) && v.length <= MAX_CHAT_IMAGES && v.every((image) => isChatImage(image));
}

type ImageChannel = 'image:read' | 'image:reveal' | 'image:copy' | 'image:save';

const EXT_BY_TYPE: Readonly<Record<string, string>> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
type ImageHandlers = { [K in ImageChannel]: (req: unknown) => Promise<InvokeResponse<K>> };

export function imageHandlers(
  requireThread: (channel: string, threadId: unknown) => Thread,
  actions: ImageActions,
  media?: MediaStore,
): ImageHandlers {
  const threadOf = (channel: string, req: unknown): Thread => {
    assertReq(channel, isPlainObject(req), 'threadId required');
    return requireThread(channel, (req as { threadId?: unknown }).threadId);
  };
  const pathOf = (channel: string, req: unknown): string => {
    const path = (req as { path?: unknown }).path;
    assertReq(channel, isNonEmptyString(path) && path.length <= 4096 && !path.includes('\0'), 'path required');
    return path as string;
  };

  const refOf = (req: unknown): unknown => (req as { ref?: unknown }).ref;
  const readRef = async (channel: string, thread: Thread, ref: unknown) => {
    assertReq(channel, !!media, 'media store unavailable');
    return media!.read(thread.id, ref);
  };

  /** Bytes + file name of what a lightbox shows: a media store ref, an inline image or a thread-folder file. */
  const bitmapOf = async (channel: string, req: unknown): Promise<{ buffer: Buffer; name: string }> => {
    const thread = threadOf(channel, req);
    if (refOf(req) !== undefined) {
      const { buffer } = await readRef(channel, thread, refOf(req));
      return { buffer, name: `hopecode-${String(refOf(req)).slice(0, 12)}${extname(String(refOf(req)))}` };
    }
    const image = (req as { image?: unknown }).image;
    if (image !== undefined) {
      // Inline tool images may be as large as any image file main reads (10 MB).
      assertReq(channel, isChatImage(image, Math.ceil((MAX_IMAGE_BYTES * 4) / 3)), 'invalid image');
      const { mediaType, data } = image as ChatImage;
      return { buffer: Buffer.from(data, 'base64'), name: `hopecode-image.${EXT_BY_TYPE[mediaType]}` };
    }
    const { abs, buffer } = await readThreadImage(thread.cwd, pathOf(channel, req));
    assertReq(channel, extname(abs).toLowerCase() !== '.svg', 'SVG images cannot be copied as bitmaps');
    return { buffer, name: basename(abs) };
  };

  return {
    'image:read': async (req) => {
      const thread = threadOf('image:read', req);
      if (refOf(req) !== undefined) {
        const { mediaType, buffer } = await readRef('image:read', thread, refOf(req));
        return { dataUrl: `data:${mediaType};base64,${buffer.toString('base64')}` };
      }
      return { dataUrl: await readThreadImageDataUrl(thread.cwd, pathOf('image:read', req)) };
    },

    'image:reveal': async (req) => {
      const thread = threadOf('image:reveal', req);
      const { abs } = resolveThreadImage(thread.cwd, pathOf('image:reveal', req));
      await actions.reveal(abs);
    },

    'image:copy': async (req) => {
      await actions.copy((await bitmapOf('image:copy', req)).buffer);
    },

    'image:save': async (req) => {
      const { buffer, name } = await bitmapOf('image:save', req);
      return { saved: await actions.save(buffer, name) };
    },
  };
}
