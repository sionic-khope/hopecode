import { useCallback, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import type { AcpPromptCaps, AgentKind, AttachRejection, AttachResult, AttachmentInfo, ChatFileMeta } from '../../../shared/types';
import { AGENTS } from '../../../shared/agents';
import { MAX_ATTACHMENTS, MAX_ATTACH_READ_BYTES, admitAttachments, extOf, formatBytes, unsupportedReason } from '../../../core/attachments';
import { attachDropped, invoke } from '../../api';
import { ipcErrorMessage } from '../../errors';
import { playSfx } from '../../sound/engine';
import { inlineDataUrl } from './ChatImages';
import { t } from '../../../shared/i18n';
import './Images.css';

/** Who the attachments go to: the agent (and its session's prompt capabilities, null = not known yet) and folder. */
export interface AttachTarget {
  agent: AgentKind;
  caps: AcpPromptCaps | null;
  threadId?: string;
  projectId?: string;
}

function problemText(problems: readonly AttachRejection[]): string | null {
  const first = problems[0];
  if (!first) return null;
  const more = problems.length > 1 ? ` ${t('attach.moreProblems', { count: problems.length - 1 })}` : '';
  return `${first.name}: ${first.reason}${more}`;
}

/** Bytes of pasted files (no path) for `attach:paste`; oversized ones are refused here without being read. */
async function readPasted(files: File[]): Promise<{ blobs: { name: string; bytes: Uint8Array }[]; rejected: AttachRejection[] }> {
  const blobs: { name: string; bytes: Uint8Array }[] = [];
  const rejected: AttachRejection[] = [];
  for (const [i, file] of files.entries()) {
    // Main refuses a paste of more than MAX_ATTACHMENTS items outright; the rest get their reason here.
    if (i >= MAX_ATTACHMENTS) {
      rejected.push({ name: file.name, reason: t('attach.maxCount', { max: MAX_ATTACHMENTS }) });
      continue;
    }
    if (file.size > MAX_ATTACH_READ_BYTES) {
      rejected.push({ name: file.name, reason: t('attach.tooLarge', { size: formatBytes(MAX_ATTACH_READ_BYTES) }) });
      continue;
    }
    // Clipboard images arrive as `image.png`; a nameless one is named after its type so main can match the magic.
    const name = file.name || `pasted.${file.type.split('/')[1] ?? 'bin'}`;
    blobs.push({ name, bytes: new Uint8Array(await file.arrayBuffer()) });
  }
  return { blobs, rejected };
}

/**
 * Composer attachments: "파일 첨부" (main's native picker), paste (⌘V) and drag & drop. Main reads and types every
 * file; this hook keeps the ids, refuses what the target agent cannot take and the count / size caps. `null` target =
 * a plain text composer (paste and drop untouched).
 */
export function useComposerAttachments(target: AttachTarget | null) {
  const [items, setItemsState] = useState<AttachmentInfo[]>([]);
  const current = useRef<AttachmentInfo[]>([]);
  const targetRef = useRef(target);
  targetRef.current = target;
  const setItems = useCallback((next: AttachmentInfo[]) => {
    current.current = next;
    setItemsState(next);
  }, []);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const accept = useCallback(
    (res: AttachResult, extra: readonly AttachRejection[] = []) => {
      const t = targetRef.current;
      if (!t) return;
      const problems: AttachRejection[] = [...extra, ...res.rejected];
      const supported = res.attachments.filter((a) => {
        const why = unsupportedReason(t.agent, t.caps, a, AGENTS[t.agent].name);
        if (why) problems.push({ name: a.name, reason: why });
        return why === null;
      });
      const { accepted, rejected } = admitAttachments(current.current, supported);
      problems.push(...rejected);
      if (accepted.length > 0) {
        setItems([...current.current, ...accepted]);
        playSfx('select');
      }
      setError(problemText(problems));
    },
    [setItems],
  );

  const run = useCallback(
    (work: Promise<{ res: AttachResult; extra?: AttachRejection[] }>) => {
      setError(null);
      work
        .then(({ res, extra }) => accept(res, extra))
        .catch((err: unknown) => setError(t('attach.failed', { error: ipcErrorMessage(err) })));
    },
    [accept],
  );

  /** "파일 첨부": the native picker opens in main, at the thread / project folder. */
  const pick = useCallback(() => {
    const t = targetRef.current;
    if (!t) return;
    const req = t.threadId ? { threadId: t.threadId } : t.projectId ? { projectId: t.projectId } : {};
    run(invoke('attach:pick', req).then((res) => ({ res })));
  }, [run]);

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!target) return;
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length === 0) return;
    e.preventDefault();
    run(
      readPasted(files).then(async ({ blobs, rejected }) => ({
        res: blobs.length > 0 ? await invoke('attach:paste', { files: blobs }) : { attachments: [], rejected: [] },
        extra: rejected,
      })),
    );
  };

  const hasFiles = (e: DragEvent<HTMLDivElement>) => Array.from(e.dataTransfer.types).includes('Files');
  const dropProps = target
    ? {
        onDragEnter: (e: DragEvent<HTMLDivElement>) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          setDragging(true);
        },
        onDragOver: (e: DragEvent<HTMLDivElement>) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
          setDragging(true);
        },
        onDragLeave: (e: DragEvent<HTMLDivElement>) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
        },
        onDrop: (e: DragEvent<HTMLDivElement>) => {
          setDragging(false);
          const files = Array.from(e.dataTransfer.files);
          if (files.length === 0) return;
          e.preventDefault();
          run(attachDropped(files).then((res) => ({ res })));
        },
      }
    : {};

  const clear = useCallback(() => {
    setItems([]);
    setError(null);
  }, [setItems]);

  const remove = useCallback(
    (id: string) => {
      playSfx('back');
      setItems(current.current.filter((a) => a.id !== id));
      setError(null);
    },
    [setItems],
  );

  /**
   * Send-time check against the current target (the draft's agent may have changed since attaching). Shows the
   * reason and returns false when an attachment cannot go to this agent.
   */
  const checkBeforeSend = useCallback((): boolean => {
    const target = targetRef.current;
    if (!target) return true;
    const problems = current.current.flatMap((a) => {
      const why = unsupportedReason(target.agent, target.caps, a, AGENTS[target.agent].name);
      return why ? [{ name: a.name, reason: why }] : [];
    });
    if (problems.length === 0) return true;
    setError(t('attach.removeBeforeSend', { problem: problemText(problems) ?? '' }));
    return false;
  }, []);

  return { items, error, dragging, pick, onPaste, dropProps, clear, remove, checkBeforeSend };
}

/** Short type badge of a file chip (`PDF`, `MD`, `TS`). */
export function fileBadge(file: Pick<ChatFileMeta, 'kind' | 'name'>): string {
  if (file.kind === 'pdf') return 'PDF';
  const ext = extOf(file.name);
  return (ext || 'TXT').slice(0, 4).toUpperCase();
}

/** File chip body: type badge, name, size (shared by the composer tray and the user bubble). */
export function FileChipBody({ file }: { file: Pick<ChatFileMeta, 'kind' | 'name' | 'size'> }) {
  return (
    <>
      <span className={`hc-attach-chip__badge hc-attach-chip__badge--${file.kind}`} aria-hidden>
        {fileBadge(file)}
      </span>
      <span className="hc-attach-chip__name" title={file.name}>
        {file.name}
      </span>
      <span className="hc-attach-chip__size">{formatBytes(file.size)}</span>
    </>
  );
}

function RemoveGlyph() {
  return (
    <svg width={8} height={8} viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="square" aria-hidden>
      <path d="M1.5 1.5l5 5M6.5 1.5l-5 5" />
    </svg>
  );
}

/** Attachment row above the composer's input: image thumbnails and file chips, each with a remove button. */
export function ComposerAttachmentTray({
  items,
  error,
  onRemove,
}: {
  items: AttachmentInfo[];
  error: string | null;
  onRemove: (id: string) => void;
}) {
  if (items.length === 0 && !error) return null;
  let imageNo = 0;
  return (
    <div className="hc-composer-images" data-testid="composer-images">
      {items.map((a) => {
        if (a.kind === 'image' && a.image) {
          imageNo += 1;
          const label = t('attach.imageLabel', { n: imageNo });
          return (
            <div key={a.id} className="hc-composer-image" title={`${a.name} · ${formatBytes(a.size)}${a.resized ? ` ${t('attach.resized')}` : ''}`}>
              <img src={inlineDataUrl(a.image)} alt={label} draggable={false} />
              <button type="button" className="hc-composer-image__remove" aria-label={t('attach.remove', { name: label })} onClick={() => onRemove(a.id)}>
                <RemoveGlyph />
              </button>
            </div>
          );
        }
        return (
          <div key={a.id} className="hc-attach-chip" data-testid="attachment-chip" data-kind={a.kind}>
            <FileChipBody file={{ kind: a.kind === 'pdf' ? 'pdf' : 'text', name: a.name, size: a.size }} />
            <button type="button" className="hc-attach-chip__remove" aria-label={t('attach.removeFile', { name: a.name })} onClick={() => onRemove(a.id)}>
              <RemoveGlyph />
            </button>
          </div>
        );
      })}
      {error ? (
        <span className="hc-composer-images__error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}

/** PDF / text attachments in the user bubble (names and sizes only; the content never comes back from main). */
export function UserFiles({ files }: { files: ChatFileMeta[] }) {
  return (
    <div className="hc-attach-row hc-attach-row--user" data-testid="user-files">
      {files.map((f, i) => (
        <div key={`${f.name}-${i}`} className="hc-attach-chip hc-attach-chip--sent" data-testid="user-file-chip" data-kind={f.kind}>
          <FileChipBody file={f} />
        </div>
      ))}
    </div>
  );
}
