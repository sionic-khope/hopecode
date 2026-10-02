// Composer attachments held in main (plan: 파일 첨부). Files are read here only: from paths the native picker or a
// drop handed over (real path, regular file, size cap before reading) or from pasted bytes. Every file is typed by
// extension + magic bytes (core/attachments). The renderer gets an id and a preview; `chat:send` / `thread:start`
// resolve the ids back to the validated content, so nothing the renderer sends is trusted as file content.
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import {
  MAX_ATTACH_READ_BYTES,
  MAX_ATTACH_TOTAL_BYTES,
  MAX_ATTACHMENTS,
  MAX_IMAGE_ATTACH_BYTES,
  classifyAttachment,
  decodeText,
  formatBytes,
  imagePixelProblem,
  sizeProblem,
  type ImageMediaType,
} from '../../core/attachments';
import type { AttachRejection, AttachResult, AttachmentInfo, ChatImage, PromptFile } from '../../shared/types';
import { t } from '../../shared/i18n';

/** Scales an image down until its encoding fits `maxBytes` (Electron nativeImage in the app); null = cannot. */
export type ImageResizer = (bytes: Buffer, mediaType: ImageMediaType, maxBytes: number) => { bytes: Buffer; mediaType: ImageMediaType } | null;

/** One validated attachment. `image` / `file` carry the content sent with the prompt. */
interface Entry {
  info: AttachmentInfo;
  image?: ChatImage;
  file?: PromptFile;
  /** When it was added (TTL). */
  at: number;
}

/** Entries kept for composers that have not sent yet (oldest dropped first). */
const MAX_ENTRIES = 64;
/** An attachment never sent is forgotten after this long. */
export const ATTACHMENT_TTL_MS = 30 * 60 * 1000;
/** Bytes of every held attachment together (oldest dropped first). */
export const MAX_HELD_BYTES = 200 * 1024 * 1024;
/** Read-only, never blocking on a FIFO / device swapped in after the checks, never through a symlink. */
const OPEN_FLAGS = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW;
const MAX_NAME_CHARS = 255;

export class AttachmentError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'AttachmentError';
  }
}

/** Display name: last path segment, no control chars, at most 255 chars. */
export function safeName(name: string): string {
  const base = (name.split(/[\\/]/).pop() ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return (base || 'pasted').slice(0, MAX_NAME_CHARS);
}

export interface Resolved {
  images: ChatImage[];
  files: PromptFile[];
  infos: AttachmentInfo[];
}

export class AttachmentStore {
  private readonly entries = new Map<string, Entry>();
  private heldBytes = 0;

  constructor(private readonly opts: { resizeImage?: ImageResizer; now?: () => number } = {}) {}

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private drop(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    this.heldBytes -= entry.info.size;
  }

  /** Expired entries out, then the oldest until the count and byte caps hold (Map order = insertion order). */
  private prune(): void {
    const cutoff = this.now() - ATTACHMENT_TTL_MS;
    for (const [id, entry] of this.entries) if (entry.at <= cutoff) this.drop(id);
    while (this.entries.size > MAX_ENTRIES || this.heldBytes > MAX_HELD_BYTES) this.drop(this.entries.keys().next().value as string);
  }

  /** A picked / dropped file: absolute path -> real path -> regular file within the read cap -> typed content. */
  async fromPath(path: unknown): Promise<AttachmentInfo> {
    if (typeof path !== 'string' || path.length === 0 || path.length > 4096 || path.includes('\0') || !isAbsolute(path)) {
      throw new AttachmentError(t('attach.badPath'));
    }
    let real: string;
    try {
      real = await realpath(path);
    } catch {
      throw new AttachmentError(t('error.fileNotFound'));
    }
    // stat before open: a FIFO / device would block the open itself.
    const pre = await stat(real).catch(() => null);
    if (!pre) throw new AttachmentError(t('error.fileNotFound'));
    if (pre.isDirectory()) throw new AttachmentError(t('attach.folder'));
    if (!pre.isFile()) throw new AttachmentError(t('attach.regularOnly'));
    if (pre.size > MAX_ATTACH_READ_BYTES) throw new AttachmentError(t('attach.tooLarge', { size: formatBytes(MAX_ATTACH_READ_BYTES) }));
    const fh = await open(real, OPEN_FLAGS).catch(() => {
      throw new AttachmentError(t('attach.regularOnly'));
    });
    let bytes: Buffer;
    try {
      const st = await fh.stat();
      // Swapped between the checks and the open: refuse rather than read something else.
      if (!st.isFile() || st.ino !== pre.ino || st.dev !== pre.dev) throw new AttachmentError(t('attach.regularOnly'));
      const buf = Buffer.alloc(Math.min(st.size, MAX_ATTACH_READ_BYTES) + 1);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      if (bytesRead > MAX_ATTACH_READ_BYTES) throw new AttachmentError(t('attach.tooLarge', { size: formatBytes(MAX_ATTACH_READ_BYTES) }));
      bytes = buf.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
    return this.add(basename(real), bytes, real);
  }

  /** Pasted / path-less dropped bytes. */
  fromBytes(name: unknown, bytes: unknown): AttachmentInfo {
    if (typeof name !== 'string' || name.length > 4096) throw new AttachmentError(t('attach.badName'));
    if (!(bytes instanceof Uint8Array)) throw new AttachmentError(t('attach.badFile'));
    if (bytes.length > MAX_ATTACH_READ_BYTES) throw new AttachmentError(t('attach.tooLarge', { size: formatBytes(MAX_ATTACH_READ_BYTES) }));
    return this.add(safeName(name), Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), undefined);
  }

  /** Runs `read` per item (at most MAX_ATTACHMENTS), collecting rejections with their reason. */
  async collect<T>(items: readonly T[], nameOf: (item: T) => string, read: (item: T) => Promise<AttachmentInfo> | AttachmentInfo): Promise<AttachResult> {
    const attachments: AttachmentInfo[] = [];
    const rejected: AttachRejection[] = [];
    for (const [i, item] of items.entries()) {
      const name = safeName(nameOf(item));
      if (i >= MAX_ATTACHMENTS) {
        rejected.push({ name, reason: t('attach.maxCount', { max: MAX_ATTACHMENTS }) });
        continue;
      }
      try {
        attachments.push(await read(item));
      } catch (err) {
        rejected.push({ name, reason: err instanceof AttachmentError ? err.reason : t('attach.readFailed') });
      }
    }
    return { attachments, rejected };
  }

  /**
   * Content of `ids` in order; null when an id is unknown (expired) or the message exceeds the count / total cap.
   * A successful resolve hands the content over: the entries are forgotten (one send per attachment). `accept`
   * may still refuse the set (agent cannot take it): null, and the entries stay.
   */
  resolve(ids: readonly string[], accept: (r: Resolved) => boolean = () => true): Resolved | null {
    this.prune();
    if (ids.length > MAX_ATTACHMENTS || new Set(ids).size !== ids.length) return null;
    const out: Resolved = { images: [], files: [], infos: [] };
    let total = 0;
    for (const id of ids) {
      const entry = this.entries.get(id);
      if (!entry) return null;
      total += entry.info.size;
      out.infos.push(entry.info);
      if (entry.image) out.images.push(entry.image);
      if (entry.file) out.files.push(entry.file);
    }
    if (total > MAX_ATTACH_TOTAL_BYTES || !accept(out)) return null;
    for (const id of ids) this.drop(id);
    return out;
  }

  private add(name: string, raw: Buffer, path: string | undefined): AttachmentInfo {
    const typed = classifyAttachment(name, raw);
    if (!typed.ok) throw new AttachmentError(typed.reason);
    // Header only: a bitmap too large to decode is refused before anything (resizer, renderer) decodes it.
    const pixels = typed.kind === 'image' ? imagePixelProblem(raw) : null;
    if (pixels) throw new AttachmentError(pixels);
    let bytes = raw;
    let mediaType = typed.mediaType;
    let resized = false;
    if (typed.kind === 'image' && bytes.length > MAX_IMAGE_ATTACH_BYTES) {
      const smaller = this.opts.resizeImage?.(bytes, mediaType as ImageMediaType, MAX_IMAGE_ATTACH_BYTES) ?? null;
      if (smaller && smaller.bytes.length <= MAX_IMAGE_ATTACH_BYTES) {
        bytes = smaller.bytes;
        mediaType = smaller.mediaType;
        resized = true;
      }
    }
    const problem = sizeProblem(typed.kind, bytes.length);
    if (problem) throw new AttachmentError(problem);

    const info: AttachmentInfo = {
      id: randomUUID(),
      kind: typed.kind,
      name,
      mediaType,
      size: bytes.length,
      linkable: path !== undefined,
      ...(resized ? { resized } : {}),
    };
    const entry: Entry = { info, at: this.now() };
    if (typed.kind === 'image') {
      const image: ChatImage = { mediaType: mediaType as ImageMediaType, data: bytes.toString('base64') };
      entry.image = image;
      info.image = image;
    } else {
      const data = typed.kind === 'pdf' ? bytes.toString('base64') : (decodeText(bytes) ?? '');
      entry.file = { kind: typed.kind, name, mediaType, size: bytes.length, data, ...(path ? { path } : {}) };
    }
    this.entries.set(info.id, entry);
    this.heldBytes += info.size;
    this.prune();
    return info;
  }
}
