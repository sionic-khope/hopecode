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
  /** Space left on the chosen side, so a tall panel scrolls instead of leaving the window. */
  maxHeight?: number;
}

const EDGE = 8;

/**
 * Last input modality. A menu opened with the mouse and closed with Escape hands focus back to its anchor
 * without a focus ring (`focusVisible: false`); keyboard users keep the ring.
 */
let pointerModality = false;
if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', () => (pointerModality = true), true);
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape') pointerModality = false;
    },
    true,
  );
}

function samePos(a: Pos | null, b: Pos): boolean {
  return (
    !!a && a.top === b.top && a.bottom === b.bottom && a.left === b.left && a.right === b.right && a.maxHeight === b.maxHeight
  );
}

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
    const [preferred, align] = placement.split('-') as ['top' | 'bottom', 'start' | 'end'];
    // Open on the preferred side unless the panel does not fit there and the other side has more room.
    const natural = panelRef.current?.scrollHeight ?? 0;
    const above = r.top - offset - EDGE;
    const below = vh - r.bottom - offset - EDGE;
    let side = preferred;
    if (natural > 0) {
      if (side === 'top' && natural > above && below > above) side = 'bottom';
      else if (side === 'bottom' && natural > below && above > below) side = 'top';
    }
    const next: Pos = {};
    if (side === 'top') {
      next.bottom = Math.max(EDGE, vh - r.top + offset);
      next.maxHeight = Math.max(120, r.top - offset - EDGE);
    } else {
      next.top = Math.max(EDGE, r.bottom + offset);
      next.maxHeight = Math.max(120, vh - r.bottom - offset - EDGE);
    }
    if (align === 'start') next.left = Math.min(Math.max(EDGE, r.left), vw - EDGE - (width ?? 0));
    else next.right = Math.max(EDGE, vw - r.right);
    setPos((prev) => (samePos(prev, next) ? prev : next));
  }, [anchorRef, placement, offset, width]);

  // Second pass once the panel exists: its real height decides whether it flips.
  useLayoutEffect(() => {
    if (open && pos) measure();
  }, [open, pos, measure]);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
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
        anchorRef.current?.focus({ focusVisible: !pointerModality } as FocusOptions);
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
