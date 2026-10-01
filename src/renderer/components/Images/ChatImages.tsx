import { createContext, memo, useContext, useEffect, useState } from 'react';
import type { ChatImage } from '../../../shared/types';
import { invoke } from '../../api';
import { Button, Modal } from '../common';
import './Images.css';

/** Thread whose folder image paths resolve against (MessageList provides it). */
export const ThreadImageContext = createContext<string | null>(null);

/** Displayable source of an image: inline base64, or a file inside the thread folder read through main. */
export type ImageSource = { kind: 'inline'; image: ChatImage; path?: string } | { kind: 'file'; path: string };

const MAX_CACHED = 64;
const fileCache = new Map<string, string>();

function cacheKey(threadId: string, path: string): string {
  return `${threadId}\u0000${path}`;
}

export function inlineDataUrl(image: ChatImage): string {
  return `data:${image.mediaType};base64,${image.data}`;
}

function baseName(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}

/** Image kept in main's media store (the thread log has only its ref). */
function storedRef(source: ImageSource): string | null {
  return source.kind === 'inline' && source.image.ref && !source.image.data ? source.image.ref : null;
}

/** data: URL of `source` (`null` while a file loads, `undefined` when it could not be read). */
function useImageUrl(threadId: string | null, source: ImageSource): string | null | undefined {
  const ref = storedRef(source);
  const inline = source.kind === 'inline' && !ref ? inlineDataUrl(source.image) : null;
  // Media store refs and thread-folder files both load through `image:read` (cache keys kept apart).
  const path = source.kind === 'file' ? source.path : ref ? `ref:${ref}` : null;
  const cached = threadId && path ? fileCache.get(cacheKey(threadId, path)) : undefined;
  const [loaded, setLoaded] = useState<{ key: string; url: string | undefined } | null>(null);

  useEffect(() => {
    if (!threadId || !path || cached) return;
    const key = cacheKey(threadId, path);
    let alive = true;
    invoke('image:read', ref ? { threadId, ref } : { threadId, path })
      .then(({ dataUrl }) => {
        if (fileCache.size >= MAX_CACHED) fileCache.delete(fileCache.keys().next().value as string);
        fileCache.set(key, dataUrl);
        if (alive) setLoaded({ key, url: dataUrl });
      })
      .catch(() => {
        if (alive) setLoaded({ key, url: undefined });
      });
    return () => {
      alive = false;
    };
  }, [threadId, path, cached, ref]);

  if (inline) return inline;
  if (cached) return cached;
  if (threadId && path && loaded?.key === cacheKey(threadId, path)) return loaded.url;
  return null;
}

function isSvg(source: ImageSource): boolean {
  return source.kind === 'file' && source.path.toLowerCase().endsWith('.svg');
}

export interface ImageThumbProps {
  source: ImageSource;
  /** Accessible name / lightbox title. */
  label: string;
  size?: 'sm' | 'md';
  /** Caption under the thumbnail (gallery); the whole cell hides with the thumbnail. */
  caption?: string;
  /** Lightbox subtitle (tool · page URL of a screenshot). */
  subtitle?: string;
}

/** Thumbnail button; opens the lightbox. Hidden when the file cannot be read (deleted, too large, outside). */
export const ImageThumb = memo(function ImageThumb({ source, label, size = 'md', caption, subtitle }: ImageThumbProps) {
  const threadId = useContext(ThreadImageContext);
  const url = useImageUrl(threadId, source);
  const [open, setOpen] = useState(false);
  if (url === undefined) return null;
  const thumb = (
    <>
      <button
        type="button"
        className={`hc-image-thumb hc-image-thumb--${size}`}
        aria-label={`${label} 크게 보기`}
        title={label}
        data-testid="image-thumb"
        onClick={() => setOpen(true)}
        disabled={url === null}
      >
        {url ? <img src={url} alt={label} draggable={false} /> : <span className="hc-image-thumb__loading" />}
      </button>
      {url ? (
        <ImageLightbox open={open} onClose={() => setOpen(false)} url={url} label={label} subtitle={subtitle} source={source} threadId={threadId} />
      ) : null}
    </>
  );
  if (caption === undefined) return thumb;
  return (
    <figure className="hc-image-gallery__cell">
      {thumb}
      <figcaption className="hc-image-gallery__name" title={caption}>
        {caption}
      </figcaption>
    </figure>
  );
});

function ImageLightbox({
  open,
  onClose,
  url,
  label,
  subtitle,
  source,
  threadId,
}: {
  open: boolean;
  onClose: () => void;
  url: string;
  label: string;
  subtitle?: string;
  source: ImageSource;
  threadId: string | null;
}) {
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const path = source.path;
  useEffect(() => {
    if (!open) setStatus(null);
  }, [open]);

  const reveal = () => {
    if (!threadId || !path) return;
    invoke('image:reveal', { threadId, path }).catch(() => setStatus({ ok: false, text: '파일을 찾지 못했습니다' }));
  };
  /** What main reads for copy / save: the media store ref, the inline image, or the thread-folder file. */
  const request = (id: string) => {
    const ref = storedRef(source);
    if (ref) return { threadId: id, ref };
    return source.kind === 'inline' ? { threadId: id, image: source.image } : { threadId: id, path: source.path };
  };
  const copy = () => {
    if (!threadId) return;
    invoke('image:copy', request(threadId))
      .then(() => setStatus({ ok: true, text: '이미지를 복사했습니다' }))
      .catch(() => setStatus({ ok: false, text: '이미지를 복사하지 못했습니다' }));
  };
  const save = () => {
    if (!threadId) return;
    invoke('image:save', request(threadId))
      .then(({ saved }) => {
        if (saved) setStatus({ ok: true, text: '이미지를 저장했습니다' });
      })
      .catch(() => setStatus({ ok: false, text: '이미지를 저장하지 못했습니다' }));
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={label}
      subtitle={subtitle ?? (path && path !== label ? path : undefined)}
      width={760}
      className="hc-lightbox"
      actions={
        <>
          {status ? (
            <span className={`hc-lightbox__status${status.ok ? '' : ' hc-lightbox__status--error'}`} role="status">
              {status.text}
            </span>
          ) : null}
          {threadId && path ? (
            <Button variant="secondary" onClick={reveal}>
              Finder에서 보기
            </Button>
          ) : null}
          {threadId && !isSvg(source) ? (
            <Button variant="secondary" onClick={save}>
              저장
            </Button>
          ) : null}
          {threadId && !isSvg(source) ? (
            <Button variant="primary" onClick={copy}>
              복사
            </Button>
          ) : null}
        </>
      }
    >
      <div className="hc-lightbox__stage" data-testid="image-lightbox">
        <img src={url} alt={label} className="hc-lightbox__img" draggable={false} />
      </div>
    </Modal>
  );
}

/**
 * Inline images of a tool_result / agent message (Read of an image file keeps its path for Finder). `caption`
 * (screenshots: tool · page URL) shows under the strip and as the lightbox subtitle.
 */
export function ToolImages({ images, path, caption, label: name }: { images: ChatImage[]; path?: string; caption?: string | null; label?: string }) {
  const label = name ?? (path ? baseName(path) : '도구 결과 이미지');
  return (
    <figure className="hc-image-figure" data-testid="tool-images">
      <div className="hc-image-strip">
        {images.map((image, i) => (
          <ImageThumb
            key={image.ref ?? i}
            source={{ kind: 'inline', image, path }}
            label={images.length > 1 ? `${label} ${i + 1}` : label}
            subtitle={caption ?? undefined}
          />
        ))}
      </div>
      {caption ? (
        <figcaption className="hc-image-figure__caption" data-testid="tool-images-caption" title={caption}>
          {caption}
        </figcaption>
      ) : null}
    </figure>
  );
}

/** Attachments shown in the user bubble. */
export function UserImages({ images }: { images: ChatImage[] }) {
  return (
    <div className="hc-image-strip hc-image-strip--user" data-testid="user-images">
      {images.map((image, i) => (
        <ImageThumb key={i} source={{ kind: 'inline', image }} label={`첨부 이미지 ${i + 1}`} size="sm" />
      ))}
    </div>
  );
}

/** Turn-end card: images created or changed in the thread folder during the turn. */
export function ImageGalleryCard({ paths }: { paths: string[] }) {
  return (
    <div className="hc-image-gallery" data-testid="image-gallery">
      <div className="hc-image-gallery__header">
        <span className="hc-image-gallery__title">이미지 {paths.length}개</span>
        <span className="hc-image-gallery__hint">이 턴에서 생성·변경됨</span>
      </div>
      <div className="hc-image-gallery__grid">
        {paths.map((path) => (
          <ImageThumb key={path} source={{ kind: 'file', path }} label={baseName(path)} caption={path} />
        ))}
      </div>
    </div>
  );
}
