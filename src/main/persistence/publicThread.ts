// What of a Thread may leave the runner: state.json and `thread:updated` carry a pending prompt's attachment
// metadata only. The content (image base64, PDF / text data, the file's real path) stays in the runner's memory.
import type { PendingAttachment, PendingPrompt, Thread } from '../../shared/types';
import { t } from '../../shared/i18n';

const ATTACHMENT_KINDS: ReadonlySet<string> = new Set(['image', 'pdf', 'text']);

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

function meta(raw: unknown, fallbackName: string, fallbackKind: PendingAttachment['kind']): PendingAttachment | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const kind = typeof r.kind === 'string' && ATTACHMENT_KINDS.has(r.kind) ? (r.kind as PendingAttachment['kind']) : fallbackKind;
  const size =
    typeof r.size === 'number' && Number.isFinite(r.size) && r.size >= 0
      ? r.size
      : typeof r.data === 'string'
        ? Math.floor((r.data.length * 3) / 4)
        : 0;
  return { kind, name: str(r.name, 255) || fallbackName, mediaType: str(r.mediaType, 128), size };
}

/**
 * Pending prompt without content: text, kind and `attachments` metadata. A legacy prompt that still holds
 * `images` / `files` (saved before this split) keeps only their metadata, so its resume asks for them again.
 */
export function toPublicPendingPrompt(prompt: PendingPrompt | null | undefined): PendingPrompt | null {
  if (!prompt) return null;
  const legacy = prompt as PendingPrompt & { images?: unknown; files?: unknown };
  const attachments: PendingAttachment[] = [];
  if (Array.isArray(prompt.attachments)) {
    for (const a of prompt.attachments) {
      const m = meta(a, t('attach.fallbackName'), 'text');
      if (m) attachments.push(m);
    }
  }
  if (Array.isArray(legacy.images)) {
    legacy.images.forEach((img, i) => {
      const m = meta(img, t('attach.imageN', { n: i + 1 }), 'image');
      if (m) attachments.push({ ...m, kind: 'image' });
    });
  }
  if (Array.isArray(legacy.files)) {
    for (const f of legacy.files) {
      const m = meta(f, t('attach.fallbackName'), 'text');
      if (m) attachments.push(m);
    }
  }
  return { text: prompt.text, kind: prompt.kind, ...(attachments.length > 0 ? { attachments } : {}) };
}

/** The thread as it may be saved or broadcast (pendingPrompt reduced to metadata). */
export function toPublicThread(thread: Thread): Thread {
  if (!thread.pendingPrompt) return thread;
  return { ...thread, pendingPrompt: toPublicPendingPrompt(thread.pendingPrompt) };
}
