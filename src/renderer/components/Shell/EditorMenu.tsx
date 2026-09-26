import { useEffect, useRef, useState } from 'react';
import type { EditorId, EditorInfo } from '../../../shared/types';
import { Menu, type MenuSection } from '../common';
import { GlyphChevronDown, GlyphCode, GlyphFolderOpen, GlyphTerminal } from '../common/glyphs';

export interface EditorMenuProps {
  editors: EditorInfo[];
  /** Settings > 기본 에디터 (null = first detected). */
  defaultEditor: EditorId | null;
  onOpen: (editor: EditorId) => void;
  /** Loads the installed list the first time the menu opens. */
  onLoad: () => void;
}

const TERMINALS: readonly EditorId[] = ['terminal', 'iterm', 'ghostty'];

function glyphFor(id: EditorId) {
  if (id === 'finder') return <GlyphFolderOpen />;
  if (TERMINALS.includes(id)) return <GlyphTerminal />;
  return <GlyphCode />;
}

/** "에디터에서 열기": the main part opens the default editor, the chevron lists every detected app. */
export function EditorMenu({ editors, defaultEditor, onOpen, onLoad }: EditorMenuProps) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const primary = editors.find((e) => e.id === defaultEditor) ?? editors[0] ?? null;

  useEffect(() => {
    if (editors.length === 0) onLoad();
  }, [editors.length, onLoad]);

  const sections = ([
    {
      key: 'editors',
      title: '에디터',
      kind: 'action' as const,
      items: editors
        .filter((e) => e.id !== 'finder' && !TERMINALS.includes(e.id))
        .map((e) => ({ key: e.id, label: e.name, icon: glyphFor(e.id), meta: e.id === primary?.id ? '기본' : undefined, onSelect: () => onOpen(e.id) })),
    },
    {
      key: 'other',
      title: '폴더 · 터미널',
      kind: 'action' as const,
      items: editors
        .filter((e) => e.id === 'finder' || TERMINALS.includes(e.id))
        .map((e) => ({ key: e.id, label: e.name, icon: glyphFor(e.id), meta: e.id === primary?.id ? '기본' : undefined, onSelect: () => onOpen(e.id) })),
    },
  ] satisfies MenuSection[]).filter((s) => s.items.length > 0);

  return (
    <div ref={anchorRef} className="hc-toolbar-split" role="group" aria-label="에디터에서 열기">
      <button
        type="button"
        className="hc-toolbar-btn hc-toolbar-split__main"
        aria-label={primary ? `${primary.name}에서 열기` : '에디터에서 열기'}
        title={primary ? `${primary.name}에서 열기` : '에디터에서 열기'}
        disabled={!primary}
        onClick={() => primary && onOpen(primary.id)}
      >
        {primary ? glyphFor(primary.id) : <GlyphCode />}
        <span className="hc-toolbar-btn__label">열기</span>
      </button>
      <button
        type="button"
        className="hc-toolbar-btn hc-toolbar-split__more"
        aria-label="열 앱 선택"
        aria-haspopup="menu"
        aria-expanded={open}
        title="열 앱 선택"
        onClick={() => setOpen((v) => !v)}
      >
        <GlyphChevronDown />
      </button>
      <Menu
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={anchorRef}
        sections={sections}
        label="에디터에서 열기"
        placement="bottom-end"
        width={240}
      />
    </div>
  );
}
