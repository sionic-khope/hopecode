import { useCallback, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import type { ChatImage } from '../../../shared/types';
import { inlineDataUrl } from './ChatImages';
import './Images.css';

/** Mirrors main's chat:send limits (at most 8 images, 5 MB each: the API's per-image limit). */
export const MAX_COMPOSER_IMAGES = 8;
export const MAX_COMPOSER_IMAGE_BYTES = 5 * 1024 * 1024;
const ACCEPTED: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

function readAsImage(file: File): Promise<ChatImage> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result ?? '');
      const comma = url.indexOf(',');
      if (comma < 0) return reject(new Error('unreadable image'));
      resolve({ mediaType: file.type as ChatImage['mediaType'], data: url.slice(comma + 1) });
    };
    reader.onerror = () => reject(reader.error ?? new Error('unreadable image'));
    reader.readAsDataURL(file);
  });
}

function imageFiles(list: DataTransferItemList | null | undefined): File[] {
  if (!list) return [];
  const files: File[] = [];
  for (const entry of Array.from(list)) {
    if (entry.kind !== 'file' || !entry.type.startsWith('image/')) continue;
    const file = entry.getAsFile();
    if (file) files.push(file);
  }
  return files;
}

/**
 * Composer image attachments: paste (⌘V) and drag & drop of PNG / JPEG / GIF / WebP files. `enabled: false`
 * leaves paste and drop untouched (plain text composer).
 */
export function useComposerImages(enabled: boolean) {
  const [images, setImagesState] = useState<ChatImage[]>([]);
  const current = useRef<ChatImage[]>([]);
  const setImages = useCallback((next: ChatImage[]) => {
    current.current = next;
    setImagesState(next);
  }, []);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const add = useCallback(async (files: File[]) => {
    setError(null);
    const problems: string[] = [];
    const accepted = files.filter((f) => {
      if (!ACCEPTED.has(f.type)) {
        problems.push('PNG, JPEG, GIF, WebP 이미지만 첨부할 수 있습니다');
        return false;
      }
      if (f.size > MAX_COMPOSER_IMAGE_BYTES) {
        problems.push('이미지는 5MB 이하만 첨부할 수 있습니다');
        return false;
      }
      return true;
    });
    const read = (await Promise.allSettled(accepted.map(readAsImage)))
      .filter((r): r is PromiseFulfilledResult<ChatImage> => r.status === 'fulfilled')
      .map((r) => r.value);
    const next = [...current.current, ...read];
    if (next.length > MAX_COMPOSER_IMAGES) problems.push(`이미지는 한 번에 ${MAX_COMPOSER_IMAGES}개까지 첨부할 수 있습니다`);
    setImages(next.slice(0, MAX_COMPOSER_IMAGES));
    if (problems.length > 0) setError(problems[0]!);
  }, [setImages]);

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!enabled) return;
    const files = imageFiles(e.clipboardData?.items);
    if (files.length === 0) return;
    e.preventDefault();
    void add(files);
  };

  const dropProps = enabled
    ? {
        onDragOver: (e: DragEvent<HTMLDivElement>) => {
          if (!Array.from(e.dataTransfer.types).includes('Files')) return;
          e.preventDefault();
          setDragging(true);
        },
        onDragLeave: (e: DragEvent<HTMLDivElement>) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
        },
        onDrop: (e: DragEvent<HTMLDivElement>) => {
          setDragging(false);
          const files = imageFiles(e.dataTransfer.items);
          if (files.length === 0) return;
          e.preventDefault();
          void add(files);
        },
      }
    : {};

  const clear = useCallback(() => {
    setImages([]);
    setError(null);
  }, [setImages]);
  const remove = useCallback(
    (index: number) => setImages(current.current.filter((_, i) => i !== index)),
    [setImages],
  );

  return { images, error, dragging, onPaste, dropProps, clear, remove };
}

/** Attached images above the composer's control row (remove buttons). */
export function ComposerImageTray({
  images,
  error,
  onRemove,
}: {
  images: ChatImage[];
  error: string | null;
  onRemove: (index: number) => void;
}) {
  if (images.length === 0 && !error) return null;
  return (
    <div className="hc-composer-images" data-testid="composer-images">
      {images.map((image, i) => (
        <div key={i} className="hc-composer-image">
          <img src={inlineDataUrl(image)} alt={`첨부 이미지 ${i + 1}`} draggable={false} />
          <button
            type="button"
            className="hc-composer-image__remove"
            aria-label={`첨부 이미지 ${i + 1} 제거`}
            onClick={() => onRemove(i)}
          >
            <svg width={8} height={8} viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" aria-hidden>
              <path d="M1.5 1.5l5 5M6.5 1.5l-5 5" />
            </svg>
          </button>
        </div>
      ))}
      {error ? (
        <span className="hc-composer-images__error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}
