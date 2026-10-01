// Composer attachments held in main (plan: 파일 첨부). Files are read here only: from paths the native picker or a
// drop handed over (real path, regular file, size cap before reading) or from pasted bytes. Every file is typed by
// extension + magic bytes (core/attachments). The renderer gets an id and a preview; `chat:send` / `thread:start`
// resolve the ids back to the validated content, so nothing the renderer sends is trusted as file content.
import { randomUUID } from 'node:crypto';
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
  sizeProblem,
  type ImageMediaType,
} from '../../core/attachments';
import type { AttachRejection, AttachResult, AttachmentInfo, ChatImage, PromptFile } from '../../shared/types';

/** Scales an image down until its encoding fits `maxBytes` (Electron nativeImage in the app); null = cannot. */
export type ImageResizer = (bytes: Buffer, mediaType: ImageMediaType, maxBytes: number) => { bytes: Buffer; mediaType: ImageMediaType } | null;

/** One validated attachment. `image` / `file` carry the content sent with the prompt. */
interface Entry {
  info: AttachmentInfo;
  image?: ChatImage;
  file?: PromptFile;
}

/** Entries kept for composers that have not sent yet (oldest dropped first). */
const MAX_ENTRIES = 64;
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

  constructor(private readonly opts: { resizeImage?: ImageResizer } = {}) {}

  /** A picked / dropped file: absolute path -> real path -> regular file within the read cap -> typed content. */
  async fromPath(path: unknown): Promise<AttachmentInfo> {
    if (typeof path !== 'string' || path.length === 0 || path.length > 4096 || path.includes('\0') || !isAbsolute(path)) {
      throw new AttachmentError('잘못된 경로입니다');
    }
    let real: string;
    try {
      real = await realpath(path);
    } catch {
      throw new AttachmentError('파일을 찾을 수 없습니다');
    }
    // stat before open: a FIFO / device would block the open itself.
    const pre = await stat(real).catch(() => null);
    if (!pre) throw new AttachmentError('파일을 찾을 수 없습니다');
    if (pre.isDirectory()) throw new AttachmentError('폴더는 첨부할 수 없습니다');
    if (!pre.isFile()) throw new AttachmentError('일반 파일만 첨부할 수 있습니다');
    if (pre.size > MAX_ATTACH_READ_BYTES) throw new AttachmentError(`${formatBytes(MAX_ATTACH_READ_BYTES)}보다 큽니다`);
    const fh = await open(real, 'r');
    let bytes: Buffer;
    try {
      const st = await fh.stat();
      // Swapped between the checks and the open: refuse rather than read something else.
      if (!st.isFile() || st.ino !== pre.ino || st.dev !== pre.dev) throw new AttachmentError('일반 파일만 첨부할 수 있습니다');
      const buf = Buffer.alloc(Math.min(st.size, MAX_ATTACH_READ_BYTES) + 1);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      if (bytesRead > MAX_ATTACH_READ_BYTES) throw new AttachmentError(`${formatBytes(MAX_ATTACH_READ_BYTES)}보다 큽니다`);
      bytes = buf.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
    return this.add(basename(real), bytes, real);
  }

  /** Pasted / path-less dropped bytes. */
  fromBytes(name: unknown, bytes: unknown): AttachmentInfo {
    if (typeof name !== 'string' || name.length > 4096) throw new AttachmentError('잘못된 파일 이름입니다');
    if (!(bytes instanceof Uint8Array)) throw new AttachmentError('잘못된 파일입니다');
    if (bytes.length > MAX_ATTACH_READ_BYTES) throw new AttachmentError(`${formatBytes(MAX_ATTACH_READ_BYTES)}보다 큽니다`);
    return this.add(safeName(name), Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), undefined);
  }

  /** Runs `read` per item (at most MAX_ATTACHMENTS), collecting rejections with their reason. */
  async collect<T>(items: readonly T[], nameOf: (item: T) => string, read: (item: T) => Promise<AttachmentInfo> | AttachmentInfo): Promise<AttachResult> {
    const attachments: AttachmentInfo[] = [];
    const rejected: AttachRejection[] = [];
    for (const [i, item] of items.entries()) {
      const name = safeName(nameOf(item));
      if (i >= MAX_ATTACHMENTS) {
        rejected.push({ name, reason: `한 메시지에 ${MAX_ATTACHMENTS}개까지 첨부할 수 있습니다` });
        continue;
      }
      try {
        attachments.push(await read(item));
      } catch (err) {
        rejected.push({ name, reason: err instanceof AttachmentError ? err.reason : '파일을 읽지 못했습니다' });
      }
    }
    return { attachments, rejected };
  }

  /** Content of `ids` in order; null when an id is unknown (expired) or the message exceeds the count / total cap. */
  resolve(ids: readonly string[]): Resolved | null {
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
    return total > MAX_ATTACH_TOTAL_BYTES ? null : out;
  }

  private add(name: string, raw: Buffer, path: string | undefined): AttachmentInfo {
    const typed = classifyAttachment(name, raw);
    if (!typed.ok) throw new AttachmentError(typed.reason);
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
    const entry: Entry = { info };
    if (typed.kind === 'image') {
      const image: ChatImage = { mediaType: mediaType as ImageMediaType, data: bytes.toString('base64') };
      entry.image = image;
      info.image = image;
    } else {
      const data = typed.kind === 'pdf' ? bytes.toString('base64') : (decodeText(bytes) ?? '');
      entry.file = { kind: typed.kind, name, mediaType, size: bytes.length, data, ...(path ? { path } : {}) };
    }
    this.entries.set(info.id, entry);
    while (this.entries.size > MAX_ENTRIES) this.entries.delete(this.entries.keys().next().value as string);
    return info;
  }
}
