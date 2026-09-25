import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import './common.css';

export type PopoverPlacement = 'top-start' | 'top-end' | 'bottom-start' | 'bottom-end';

export interface PopoverProps {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  placement?: PopoverPlacement;
  /** px gap between anchor and popover */
  offset?: number;
  width?: number;
  className?: string;
  'aria-label'?: string;
  children: ReactNode;
}

interface Pos {
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
}

const EDGE = 8;

/** Anchored floating panel (portal). Closes on outside click and Escape. */
export function Popover({
  open,
  onClose,
  anchorRef,
  placement = 'bottom-start',
  offset = 6,
  width,
  className,
  children,
  ...aria
}: PopoverProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<Pos | null>(null);

  const measure = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const [side, align] = placement.split('-') as ['top' | 'bottom', 'start' | 'end'];
    const next: Pos = {};
    if (side === 'top') next.bottom = Math.max(EDGE, vh - r.top + offset);
    else next.top = Math.max(EDGE, r.bottom + offset);
    if (align === 'start') next.left = Math.min(Math.max(EDGE, r.left), vw - EDGE - (width ?? 0));
    else next.right = Math.max(EDGE, vw - r.right);
    setPos(next);
  }, [anchorRef, placement, offset, width]);

  useLayoutEffect(() => {
    if (!open) return;
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [open, measure]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || anchorRef.current?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        anchorRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, onClose, anchorRef]);

  if (!open || !pos) return null;

  const shift = placement.startsWith('top') ? '4px' : '-4px';
  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      className={['hc-popover', className ?? ''].filter(Boolean).join(' ')}
      style={{ ...pos, width, ['--hc-popover-shift' as string]: shift }}
      {...aria}
    >
      {children}
    </div>,
    document.body,
  );
}
