import { meterFill, meterLevel } from '../../../core/meter';
import { formatPercent, formatResetCountdown } from '../../../core/format';
import './StatusLine.css';

export interface UsageMeterProps {
  label: string;
  /** 0..100, null when no data for this kind. */
  percent: number | null;
  /**
   * epoch ms of the next reset. Omit entirely to hide the countdown segment
   * (used by the ctx meter, which has no reset). `null` renders no countdown either.
   */
  resetsAt?: number | null;
  now: number;
  /** Track width in px (spec: 44 for 5h/wk/fable, 32 for ctx). */
  width?: number;
  /** Data older than the staleness window (shows `*` + tooltip). */
  stale?: boolean;
  /** RPG gauge in the statusline: `hp` (5h window, yellow on dark red) or `tp` (context, orange). Prefixes the tag. */
  gauge?: 'hp' | 'tp';
}

const GAUGE_TAG: Record<NonNullable<UsageMeterProps['gauge']>, string> = { hp: 'HP', tp: 'TP' };

/** Capsule progress meter used by the statusline and the accounts popover (plan 6). */
export function UsageMeter({ label, percent, resetsAt, now, width = 44, stale = false, gauge }: UsageMeterProps) {
  let level: 'ok' | 'warn' | 'crit' = 'ok';
  let fill = 0;
  let percentText = '–';

  if (percent != null) {
    try {
      level = meterLevel(percent);
      fill = meterFill(percent);
    } catch {
      // core/meter is a stub until 1A lands; keep the track empty instead of crashing the shell.
    }
    try {
      percentText = formatPercent(percent);
    } catch {
      percentText = `${Math.round(percent)}%`;
    }
  }

  let countdown: string | null = null;
  if (resetsAt !== undefined) {
    try {
      countdown = formatResetCountdown(resetsAt, now);
    } catch {
      countdown = null;
    }
  }

  return (
    <span
      className={`hc-statusline__segment hc-meter${gauge ? ` hc-meter--${gauge}` : ''}`}
      title={stale ? 'Not updated for 15+ minutes' : undefined}
    >
      {gauge ? (
        <span className="hc-meter__gauge" aria-hidden>
          {GAUGE_TAG[gauge]}
        </span>
      ) : null}
      <span className="hc-meter__label">{label}</span>
      <span className="hc-meter__track" style={{ width }}>
        <span className={`hc-meter__fill hc-meter__fill--${level}`} style={{ width: `${Math.round(fill * 100)}%` }} />
      </span>
      <span className={`hc-meter__percent ${level === 'crit' ? 'hc-meter__percent--crit' : ''}`}>
        {percentText}
        {stale ? '*' : ''}
      </span>
      {countdown ? <span className="hc-meter__reset">· {countdown}</span> : null}
    </span>
  );
}
