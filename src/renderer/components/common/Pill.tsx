import type { HTMLAttributes, ReactNode } from 'react';
import './common.css';

export type PillTone = 'neutral' | 'accent' | 'ok' | 'warn' | 'crit';

export interface PillProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: PillTone;
  /** Fully rounded capsule instead of 6px radius. */
  capsule?: boolean;
  /** Leading color dot (e.g. account color). */
  dotColor?: string;
  children?: ReactNode;
}

export function Pill({ tone = 'neutral', capsule = false, dotColor, className, children, ...rest }: PillProps) {
  const cls = ['hc-pill', tone !== 'neutral' ? `hc-pill--${tone}` : '', capsule ? 'hc-pill--capsule' : '', className ?? '']
    .filter(Boolean)
    .join(' ');
  return (
    <span className={cls} {...rest}>
      {dotColor ? <span className="hc-pill__dot" style={{ background: dotColor }} aria-hidden /> : null}
      {children}
    </span>
  );
}
