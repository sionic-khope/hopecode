import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import './common.css';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  /** Accessible name (also the visible title unless `hideTitle`). */
  title: string;
  /** Small line under the title. */
  subtitle?: ReactNode;
  /** Leading glyph in the header (icon tile). */
  icon?: ReactNode;
  children: ReactNode;
  /** Footer actions (right-aligned). */
  actions?: ReactNode;
  width?: number;
  /** Backdrop click / Escape close the modal (off while an action is in flight). */
  dismissible?: boolean;
  className?: string;
  /** `alertdialog` for confirmations. */
  role?: 'dialog' | 'alertdialog';
}

const FOCUSABLE = 'button:not(:disabled), [href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])';

/**
 * Centered modal card over a fading backdrop (the card slides up). Focus moves into the card on open, Tab stays
 * inside it, and closing returns focus to whatever had it before.
 */
export function Modal({
  open,
  onClose,
  title,
  subtitle,
  icon,
  children,
  actions,
  width = 460,
  dismissible = true,
  className,
  role = 'dialog',
}: ModalProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    returnFocus.current = document.activeElement as HTMLElement | null;
    const id = requestAnimationFrame(() => {
      const card = cardRef.current;
      if (!card || card.contains(document.activeElement)) return;
      const preferred = card.querySelector<HTMLElement>('[data-autofocus]') ?? card.querySelector<HTMLElement>(FOCUSABLE);
      (preferred ?? card).focus();
    });
    return () => {
      cancelAnimationFrame(id);
      returnFocus.current?.focus?.({ focusVisible: false } as FocusOptions);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && dismissible) {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const card = cardRef.current;
      if (!card) return;
      const items = [...card.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open, dismissible, onClose]);

  if (!open) return null;
  return createPortal(
    <div
      className="hc-modal-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && dismissible) onClose();
      }}
    >
      <div
        ref={cardRef}
        role={role}
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={['hc-modal', className ?? ''].filter(Boolean).join(' ')}
        style={{ width }}
      >
        <div className="hc-modal__header">
          {icon ? <div className="hc-modal__icon">{icon}</div> : null}
          <div className="hc-modal__heading">
            <h2 className="hc-modal__title">{title}</h2>
            {subtitle ? <div className="hc-modal__subtitle">{subtitle}</div> : null}
          </div>
          {dismissible ? (
            <button type="button" className="hc-modal__close" aria-label="닫기" onClick={onClose}>
              <svg width={12} height={12} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" aria-hidden>
                <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" />
              </svg>
            </button>
          ) : null}
        </div>
        <div className="hc-modal__body">{children}</div>
        {actions ? <div className="hc-modal__actions">{actions}</div> : null}
      </div>
    </div>,
    document.body,
  );
}
