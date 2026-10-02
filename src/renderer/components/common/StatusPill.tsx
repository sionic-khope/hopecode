import type { ReactNode } from 'react';
import { t, type MessageKey } from '../../../shared/i18n';
import { useLanguage } from '../../i18n';
import './common.css';

/** Pastel run-state points: running blue, waiting amber, done green, error red. */
export type RunState = 'running' | 'waiting' | 'done' | 'error';

const DEFAULT_LABEL: Record<RunState, MessageKey> = {
  running: 'status.running',
  waiting: 'status.waiting',
  done: 'status.done',
  error: 'status.error',
};

export interface StatusPillProps {
  state: RunState;
  /** Visible text (defaults to the state name). */
  children?: ReactNode;
  title?: string;
  className?: string;
}

/** Small pastel capsule with a leading dot (the running dot pulses unless motion is reduced). */
export function StatusPill({ state, children, title, className }: StatusPillProps) {
  useLanguage();
  return (
    <span className={['hc-status', `hc-status--${state}`, className ?? ''].filter(Boolean).join(' ')} title={title}>
      <span className="hc-status__dot" aria-hidden />
      <span className="hc-status__text">{children ?? t(DEFAULT_LABEL[state])}</span>
    </span>
  );
}
