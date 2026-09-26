import type { ReactNode } from 'react';
import './common.css';

/** Pastel run-state points: running blue, waiting amber, done green, error red. */
export type RunState = 'running' | 'waiting' | 'done' | 'error';

const DEFAULT_LABEL: Record<RunState, string> = {
  running: '실행 중',
  waiting: '대기 중',
  done: '완료',
  error: '오류',
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
  return (
    <span className={['hc-status', `hc-status--${state}`, className ?? ''].filter(Boolean).join(' ')} title={title}>
      <span className="hc-status__dot" aria-hidden />
      <span className="hc-status__text">{children ?? DEFAULT_LABEL[state]}</span>
    </span>
  );
}
