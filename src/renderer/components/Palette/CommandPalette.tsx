import { useEffect, useId, useMemo, useRef, useState, type JSX, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { searchPalette, type PaletteItem, type PaletteMatch } from './paletteSearch';
import '../common/common.css';
import './Palette.css';

export interface PaletteCommand extends PaletteItem {
  icon?: ReactNode;
  /** Display shortcut, e.g. '⌘N' or '⌘⇧P'; each glyph renders as its own keycap. */
  shortcut?: string;
  run: () => void;
}

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  commands: readonly PaletteCommand[];
  placeholder?: string;
}

interface Section {
  group: string | null;
  rows: { match: PaletteMatch<PaletteCommand>; index: number }[];
}

const RESULT_LIMIT = 100;
const MODIFIERS = new Set(['⌘', '⇧', '⌥', '⌃', '↵', '⏎', '⌫', '⇥', '↑', '↓', '←', '→']);

/** '⌘⇧P' -> ['⌘', '⇧', 'P']; 'Ctrl+K' -> ['Ctrl', 'K']; multi-char key names ('Esc', 'F12') stay whole. */
function shortcutKeys(shortcut: string): string[] {
  if (shortcut.includes('+')) return shortcut.split('+').map((s) => s.trim()).filter(Boolean);
  const keys: string[] = [];
  let rest = '';
  for (const ch of shortcut) {
    if (MODIFIERS.has(ch)) {
      if (rest) keys.push(rest);
      rest = '';
      keys.push(ch);
    } else {
      rest += ch;
    }
  }
  if (rest.trim()) keys.push(rest.trim());
  return keys;
}

function Highlighted({ text, ranges }: { text: string; ranges: readonly [number, number][] }) {
  if (ranges.length === 0) return <>{text}</>;
  const parts: ReactNode[] = [];
  let at = 0;
  ranges.forEach(([start, end], i) => {
    if (start > at) parts.push(text.slice(at, start));
    parts.push(
      <mark key={i} className="hc-palette__hl">
        {text.slice(start, end)}
      </mark>,
    );
    at = end;
  });
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}

function SearchGlyph() {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" aria-hidden>
      <circle cx={7} cy={7} r={4.75} />
      <path d="M10.6 10.6L14 14" />
    </svg>
  );
}

/**
 * ⌘K command palette: a search field over a ranked, keyboard-driven list. Focus lives in the input the whole time
 * (the list is driven through aria-activedescendant), so typing never stops working while you navigate.
 */
export function CommandPalette({ open, onClose, commands, placeholder = '명령 또는 스레드 검색…' }: CommandPaletteProps): JSX.Element | null {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const baseId = useId();
  const listId = `${baseId}-list`;
  const optionId = (i: number) => `${baseId}-opt-${i}`;

  // Fresh query + first row every time it opens; focus returns to its previous owner on close unless the command
  // that just ran moved focus somewhere on purpose.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
    returnFocus.current = document.activeElement as HTMLElement | null;
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => {
      cancelAnimationFrame(id);
      const now = document.activeElement;
      if (!now || now === document.body || !now.isConnected) {
        returnFocus.current?.focus?.({ focusVisible: false } as FocusOptions);
      }
      returnFocus.current = null;
    };
  }, [open]);

  const sections = useMemo<Section[]>(() => {
    const trimmed = query.trim();
    if (trimmed) {
      const matches = searchPalette(commands, trimmed, RESULT_LIMIT);
      return [{ group: null, rows: matches.map((match, index) => ({ match, index })) }];
    }
    const byGroup = new Map<string, PaletteMatch<PaletteCommand>[]>();
    for (const match of searchPalette(commands, '')) {
      const list = byGroup.get(match.item.group);
      if (list) list.push(match);
      else byGroup.set(match.item.group, [match]);
    }
    let index = 0;
    return [...byGroup].map(([group, matches]) => ({ group, rows: matches.map((match) => ({ match, index: index++ })) }));
  }, [commands, query]);

  const flat = useMemo(() => sections.flatMap((s) => s.rows.map((r) => r.match.item)), [sections]);
  const count = flat.length;
  const activeIndex = count === 0 ? -1 : Math.min(active, count - 1);

  useEffect(() => {
    if (!open || activeIndex < 0) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex, sections]);

  // Escape and Tab are caught at the document so they behave even if a click nudged focus off the input.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.isComposing) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      } else if (e.key === 'Tab') {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);

  const runAt = (i: number) => {
    const cmd = flat[i];
    if (!cmd) return;
    onClose();
    cmd.run();
  };

  const onInputKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (count > 0) setActive((activeIndex + 1) % count);
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (count > 0) setActive((activeIndex - 1 + count) % count);
        break;
      case 'Home':
        e.preventDefault();
        setActive(0);
        break;
      case 'End':
        e.preventDefault();
        if (count > 0) setActive(count - 1);
        break;
      case 'Enter':
        e.preventDefault();
        runAt(activeIndex);
        break;
      default:
        break;
    }
  };

  if (!open) return null;

  const searching = query.trim().length > 0;

  const renderRow = ({ match, index }: Section['rows'][number]) => {
    const { item, ranges } = match;
    const selected = index === activeIndex;
    return (
      <div
        key={item.id}
        id={optionId(index)}
        role="option"
        aria-selected={selected}
        data-index={index}
        className={selected ? 'hc-palette__item hc-palette__item--active' : 'hc-palette__item'}
        onMouseMove={() => {
          if (index !== activeIndex) setActive(index);
        }}
        onClick={() => runAt(index)}
      >
        <span className="hc-palette__icon" aria-hidden>
          {item.icon}
        </span>
        <span className="hc-palette__text">
          <span className="hc-palette__title">
            <Highlighted text={item.title} ranges={ranges} />
          </span>
          {item.subtitle ? <span className="hc-palette__subtitle">{item.subtitle}</span> : null}
        </span>
        {item.shortcut ? (
          <span className="hc-palette__keys" aria-label={`단축키 ${item.shortcut}`}>
            {shortcutKeys(item.shortcut).map((k, i) => (
              <kbd key={i} className="hc-kbd">
                {k}
              </kbd>
            ))}
          </span>
        ) : null}
      </div>
    );
  };

  return createPortal(
    <div
      className="hc-palette-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="명령 팔레트"
        className="hc-palette"
        data-testid="command-palette"
        onMouseDown={(e) => {
          // Keep focus (and the caret) in the search field when clicking anywhere in the card.
          if (e.target !== inputRef.current) e.preventDefault();
        }}
      >
        <div className="hc-palette__search">
          <span className="hc-palette__search-icon">
            <SearchGlyph />
          </span>
          <input
            ref={inputRef}
            className="hc-palette__input"
            type="text"
            role="combobox"
            aria-label="명령 검색"
            aria-expanded="true"
            aria-autocomplete="list"
            aria-controls={listId}
            aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
            placeholder={placeholder}
            value={query}
            autoFocus
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onInputKeyDown}
          />
        </div>

        <div ref={listRef} id={listId} role="listbox" aria-label="명령" className="hc-palette__list">
          {searching
            ? sections[0]?.rows.map(renderRow)
            : sections.map((section) => {
                const headerId = `${baseId}-grp-${section.rows[0]?.index ?? 0}`;
                return (
                  <div key={section.group ?? ''} role="group" aria-labelledby={headerId} className="hc-palette__section">
                    <div id={headerId} className="hc-palette__group">
                      {section.group}
                    </div>
                    {section.rows.map(renderRow)}
                  </div>
                );
              })}
        </div>
        {count === 0 ? (
          <div className="hc-palette__empty" role="status">
            일치하는 항목이 없습니다
          </div>
        ) : null}

        <div className="hc-palette__footer" aria-hidden>
          <span className="hc-palette__hint">
            <kbd className="hc-kbd">↑</kbd>
            <kbd className="hc-kbd">↓</kbd>
            이동
          </span>
          <span className="hc-palette__dot">·</span>
          <span className="hc-palette__hint">
            <kbd className="hc-kbd">⏎</kbd>
            실행
          </span>
          <span className="hc-palette__dot">·</span>
          <span className="hc-palette__hint">
            <kbd className="hc-kbd">esc</kbd>
            닫기
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
