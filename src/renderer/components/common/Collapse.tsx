import { useEffect, useState, type ReactNode } from 'react';
import './common.css';

/** Close animation budget (≥ --motion-3); children unmount after it. */
const UNMOUNT_AFTER_MS = 360;

/**
 * Height transition for disclosure bodies: a grid row animating 0fr <-> 1fr (no measuring). Children mount on
 * open (the expansion runs on the next frame) and unmount once the collapse finished.
 */
export function Collapse({ open, children, className }: { open: boolean; children: ReactNode; className?: string }) {
  const [mounted, setMounted] = useState(open);
  const [expanded, setExpanded] = useState(open);

  useEffect(() => {
    if (open) {
      setMounted(true);
      const id = requestAnimationFrame(() => setExpanded(true));
      return () => cancelAnimationFrame(id);
    }
    setExpanded(false);
    const t = window.setTimeout(() => setMounted(false), UNMOUNT_AFTER_MS);
    return () => window.clearTimeout(t);
  }, [open]);

  if (!mounted) return null;
  return (
    <div className={['hc-collapse', expanded ? 'hc-collapse--open' : '', className ?? ''].filter(Boolean).join(' ')}>
      <div className="hc-collapse__inner">{children}</div>
    </div>
  );
}
