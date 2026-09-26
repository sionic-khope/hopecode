import { Fragment, useEffect, useRef, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { Popover, type PopoverPlacement } from './Popover';
import './common.css';

export interface MenuItemSpec {
  /** Stable key (defaults to the label). */
  key?: string;
  label: ReactNode;
  /** Accessible name when `label` is not plain text. */
  ariaLabel?: string;
  description?: ReactNode;
  icon?: ReactNode;
  /** Right-aligned hint (shortcut, badge). */
  meta?: ReactNode;
  /** Radio items render a check and use role="menuitemradio". */
  checked?: boolean;
  disabled?: boolean;
  /** Warning tone (bypass permissions). */
  tone?: 'default' | 'warn' | 'danger';
  onSelect: () => void;
  /** Keep the menu open after selecting (multi-section pickers). */
  keepOpen?: boolean;
}

export interface MenuSection {
  key: string;
  title?: string;
  /** `radio` sections expose checked state (role="menuitemradio"). */
  kind?: 'radio' | 'action';
  items: MenuItemSpec[];
}

export interface MenuProps {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  sections: MenuSection[];
  label: string;
  placement?: PopoverPlacement;
  width?: number;
  className?: string;
  /** Non-interactive block above the first section (profile summary). */
  header?: ReactNode;
}

/**
 * Anchored menu (Popover) with sections, radio items and roving keyboard focus: ↑/↓/Home/End move,
 * Enter/Space select, Escape closes (Popover) and returns focus to the anchor.
 */
export function Menu({ open, onClose, anchorRef, sections, label, placement = 'bottom-start', width = 260, className, header }: MenuProps) {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    // After the popover positioned itself: focus the checked item, else the first enabled one.
    const id = requestAnimationFrame(() => {
      const items = enabledItems(listRef.current);
      const checked = items.find((el) => el.getAttribute('aria-checked') === 'true');
      (checked ?? items[0])?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [open]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = enabledItems(listRef.current);
    if (items.length === 0) return;
    const idx = items.indexOf(document.activeElement as HTMLElement);
    let next: HTMLElement | undefined;
    if (e.key === 'ArrowDown') next = items[(idx + 1) % items.length];
    else if (e.key === 'ArrowUp') next = items[(idx - 1 + items.length) % items.length];
    else if (e.key === 'Home') next = items[0];
    else if (e.key === 'End') next = items[items.length - 1];
    else if (e.key === 'Tab') {
      e.preventDefault();
      onClose();
      anchorRef.current?.focus();
      return;
    }
    if (next) {
      e.preventDefault();
      next.focus();
    }
  };

  return (
    <Popover open={open} onClose={onClose} anchorRef={anchorRef} placement={placement} width={width} aria-label={label} className={className}>
      <div ref={listRef} className="hc-mnu" role="menu" aria-label={label} onKeyDown={onKeyDown}>
        {header ? (
          <>
            <div className="hc-mnu__header" role="presentation">
              {header}
            </div>
            <div className="hc-mnu__sep" role="separator" />
          </>
        ) : null}
        {sections.map((section, si) => (
          <Fragment key={section.key}>
            {si > 0 ? <div className="hc-mnu__sep" role="separator" /> : null}
            <div role="group" aria-label={section.title}>
              {section.title ? <div className="hc-mnu__title">{section.title}</div> : null}
              {section.items.map((item) => {
                const radio = section.kind === 'radio';
                return (
                  <button
                    key={item.key ?? String(item.label)}
                    type="button"
                    role={radio ? 'menuitemradio' : 'menuitem'}
                    aria-checked={radio ? item.checked === true : undefined}
                    aria-label={item.ariaLabel}
                    disabled={item.disabled}
                    className={`hc-mnu__item${item.tone && item.tone !== 'default' ? ` hc-mnu__item--${item.tone}` : ''}`}
                    onClick={() => {
                      if (!item.keepOpen) onClose();
                      item.onSelect();
                    }}
                  >
                    {item.icon ? <span className="hc-mnu__icon">{item.icon}</span> : null}
                    <span className="hc-mnu__text">
                      <span className="hc-mnu__label">{item.label}</span>
                      {item.description ? <span className="hc-mnu__desc">{item.description}</span> : null}
                    </span>
                    {item.meta ? <span className="hc-mnu__meta">{item.meta}</span> : null}
                    {radio ? (
                      <span className="hc-mnu__check" aria-hidden>
                        {item.checked ? <CheckGlyph /> : null}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </Fragment>
        ))}
      </div>
    </Popover>
  );
}

function enabledItems(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return [...root.querySelectorAll<HTMLElement>('[role^="menuitem"]:not(:disabled)')];
}

function CheckGlyph() {
  return (
    <svg width={14} height={14} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
      <path d="m4.75 10.25 3.5 3.5 7-7.5" />
    </svg>
  );
}
