import { useEffect, useRef } from 'react';
import { AssistantText } from '../Chat/AssistantText';
import { MarkdownCopyChip } from '../Chat/MarkdownCopyChip';
import { GlyphClose } from '../common/glyphs';
import { useLanguage } from '../../i18n';
import { t } from '../../../shared/i18n';
import { IconNotePage } from './icons';
import type { NoteDoc } from './NoteResult';

export interface NoteDocViewerProps {
  doc: NoteDoc;
  onClose: () => void;
}

/**
 * A document from the conversation, opened like a markdown file: rendered on a page over the conversation pane, with
 * its title, "MD" copy and close (Esc). The text selects and copies like any other.
 */
export function NoteDocViewer({ doc, onClose }: NoteDocViewerProps) {
  useLanguage();
  const page = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    // Focus moves into the viewer (keys scroll the page) and back to what opened it on close.
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    page.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing) return;
      e.preventDefault();
      close.current();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);

  const lines = doc.body === '' ? 0 : doc.body.split('\n').length;

  return (
    <div className="hc-notedoc" role="dialog" aria-modal="true" aria-label={t('noteDoc.aria', { title: doc.title })} data-testid="note-doc-viewer">
      <header className="hc-notedoc__bar">
        <IconNotePage width={16} height={16} className="hc-notedoc__icon" />
        <span className="hc-notedoc__title" data-testid="note-doc-title">
          {doc.title}
        </span>
        <span className="hc-notedoc__meta">{t('code.lines', { count: lines })}</span>
        <span className="hc-notedoc__spacer" />
        <MarkdownCopyChip getText={() => doc.body} label={t('noteDoc.copy')} className="hc-notedoc__copy" />
        <button type="button" className="hc-notedoc__close" onClick={onClose} aria-label={t('common.close')} title={`${t('common.close')} (Esc)`} data-testid="note-doc-close">
          <GlyphClose width={14} height={14} />
        </button>
      </header>
      <div className="hc-notedoc__page" ref={page} tabIndex={-1} data-testid="note-doc-body">
        <div className="hc-notedoc__paper">
          <AssistantText text={doc.body} />
        </div>
      </div>
    </div>
  );
}
