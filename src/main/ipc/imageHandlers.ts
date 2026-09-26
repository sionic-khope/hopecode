// `image:*` invoke handlers (inline images, turn-end galleries, lightbox actions) + chat image validation.
// Paths come from the renderer: every one is resolved inside the thread's own folder (imageFiles.resolveThreadImage).
import { extname } from 'node:path';
import type { InvokeResponse } from '../../shared/ipc';
import type { ChatImage, Thread } from '../../shared/types';
import { MAX_IMAGE_BYTES, readThreadImage, readThreadImageDataUrl, resolveThreadImage } from '../images/imageFiles';
import { assertReq, isNonEmptyString, isPlainObject } from './guards';

/** Native side of the lightbox buttons (Electron shell / clipboard), injected so this module stays Node-only. */
export interface ImageActions {
  /** Reveals the file in Finder (a no-op in headless e2e). */
  reveal(absPath: string): Promise<void> | void;
  /** Puts an encoded PNG / JPEG / GIF / WebP image on the clipboard. */
  copy(buffer: Buffer): Promise<void> | void;
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

type ImageChannel = 'image:read' | 'image:reveal' | 'image:copy';
type ImageHandlers = { [K in ImageChannel]: (req: unknown) => Promise<InvokeResponse<K>> };

export function imageHandlers(requireThread: (channel: string, threadId: unknown) => Thread, actions: ImageActions): ImageHandlers {
  const threadOf = (channel: string, req: unknown): Thread => {
    assertReq(channel, isPlainObject(req), 'threadId required');
    return requireThread(channel, (req as { threadId?: unknown }).threadId);
  };
  const pathOf = (channel: string, req: unknown): string => {
    const path = (req as { path?: unknown }).path;
    assertReq(channel, isNonEmptyString(path) && path.length <= 4096 && !path.includes('\0'), 'path required');
    return path as string;
  };

  return {
    'image:read': async (req) => {
      const thread = threadOf('image:read', req);
      return { dataUrl: await readThreadImageDataUrl(thread.cwd, pathOf('image:read', req)) };
    },

    'image:reveal': async (req) => {
      const thread = threadOf('image:reveal', req);
      const { abs } = resolveThreadImage(thread.cwd, pathOf('image:reveal', req));
      await actions.reveal(abs);
    },

    'image:copy': async (req) => {
      const thread = threadOf('image:copy', req);
      const image = (req as { image?: unknown }).image;
      if (image !== undefined) {
        // Inline tool images may be as large as any image file main reads (10 MB).
        assertReq('image:copy', isChatImage(image, Math.ceil((MAX_IMAGE_BYTES * 4) / 3)), 'invalid image');
        await actions.copy(Buffer.from((image as ChatImage).data, 'base64'));
        return;
      }
      const { abs, buffer } = await readThreadImage(thread.cwd, pathOf('image:copy', req));
      assertReq('image:copy', extname(abs).toLowerCase() !== '.svg', 'SVG images cannot be copied as bitmaps');
      await actions.copy(buffer);
    },
  };
}
