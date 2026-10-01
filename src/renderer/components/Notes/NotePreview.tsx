import { memo } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { invoke } from '../../api';

const REMARK_PLUGINS = [remarkGfm];

/** Links open in the browser through main (https only); nothing navigates the app window. */
const COMPONENTS: Components = {
  a: ({ href, children }) => (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        if (href) void invoke('notes:openLink', { url: href }).catch(() => {});
      }}
    >
      {children}
    </a>
  ),
  // Images are not fetched (no remote loads from a note); the alt text stands in.
  img: ({ alt }) => <span className="hc-note-preview__img">[이미지{alt ? `: ${alt}` : ''}]</span>,
};

/** 읽기 전용 미리보기: GFM rendered by react-markdown; raw HTML in the note is dropped, never rendered. */
export const NotePreview = memo(function NotePreview({ text }: { text: string }) {
  return (
    <div className="hc-note-preview" data-testid="note-preview">
      <div className="hc-note-preview__body">
        <Markdown remarkPlugins={REMARK_PLUGINS} components={COMPONENTS} skipHtml>
          {text}
        </Markdown>
      </div>
    </div>
  );
});
