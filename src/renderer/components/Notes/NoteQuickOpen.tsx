import { memo, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { baseName, parentOf } from '../../../core/notes/notePaths';
import { invoke } from '../../api';
import { IconNotePage } from './icons';
import { noteError } from './NoteTree';

export interface NoteQuickOpenProps {
  onOpen: (path: string) => void;
  onClose: () => void;
}

/** ⌘P: notes by name, ↑↓ to pick, Enter to open, Esc to close. */
export const NoteQuickOpen = memo(function NoteQuickOpen({ onOpen, onClose }: NoteQuickOpenProps) {
  const [query, setQuery] = useState('');
  const [paths, setPaths] = useState<string[]>([]);
  /** The query `paths` answers (Enter before the debounced search lands searches right away). */
  const [answered, setAnswered] = useState('');
  const [active, setActive] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => input.current?.focus(), []);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setPaths([]);
      setAnswered('');
      return;
    }
    const t = window.setTimeout(() => {
      invoke('notes:search', { query: q })
        .then((res) => {
          setPaths(res.paths.slice(0, 50));
          setAnswered(q);
          setActive(0);
          setError(null);
        })
        .catch((err: unknown) => setError(noteError(err)));
    }, 120);
    return () => window.clearTimeout(t);
  }, [query]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(paths.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const q = query.trim();
      if (q && q !== answered) {
        invoke('notes:search', { query: q })
          .then((res) => res.paths[0] && onOpen(res.paths[0]))
          .catch((err: unknown) => setError(noteError(err)));
        return;
      }
      const p = paths[active];
      if (p) onOpen(p);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };

  return createPortal(
    <div className="hc-notequick__backdrop hc-modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="hc-notequick" role="dialog" aria-label="노트 빠르게 열기" data-testid="note-quickopen">
        <input
          ref={input}
          className="hc-notequick__input"
          value={query}
          placeholder="노트 이름으로 열기"
          aria-label="노트 이름으로 열기"
          role="combobox"
          aria-expanded={paths.length > 0}
          aria-controls="hc-notequick-list"
          aria-activedescendant={paths[active] ? `hc-notequick-${active}` : undefined}
          data-testid="note-quickopen-input"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <ul className="hc-notequick__list" id="hc-notequick-list" role="listbox" aria-label="노트">
          {paths.map((p, i) => (
            <li
              key={p}
              id={`hc-notequick-${i}`}
              role="option"
              aria-selected={i === active}
              className={`hc-notequick__row${i === active ? ' hc-notequick__row--active' : ''}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => onOpen(p)}
            >
              <IconNotePage className="hc-notequick__icon" />
              <span className="hc-notequick__name">{baseName(p).replace(/\.md$/i, '')}</span>
              <span className="hc-notequick__dir">{parentOf(p)}</span>
            </li>
          ))}
          {query.trim() && paths.length === 0 && !error ? <li className="hc-notequick__empty">일치하는 노트가 없습니다</li> : null}
          {!query.trim() ? <li className="hc-notequick__empty">이름 일부를 입력하세요</li> : null}
          {error ? (
            <li className="hc-notequick__empty hc-notequick__empty--error" role="alert">
              {error}
            </li>
          ) : null}
        </ul>
      </div>
    </div>,
    document.body,
  );
});
