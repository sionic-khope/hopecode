import { memo, useEffect, useRef, useState } from 'react';
import type { Account, ModelOption, PoolSnapshot, Thread } from '../../../shared/types';
import { modelLabel } from '../../../core/modelLabel';
import { formatSessionDuration } from '../../../core/format';
import { Pill } from '../common';
import { AccountsPopover } from '../Accounts/AccountsPopover';
import { UsageMeter } from './UsageMeter';
import './StatusLine.css';

export interface StatusLineProps {
  pool: PoolSnapshot;
  accounts: Account[];
  /** Thread currently shown in the chat pane; null when nothing is selected. */
  activeThread: Thread | null;
  /** Model options (`models:list`) whose labels replace raw ids. */
  models?: ModelOption[];
}

/** Ticks so the session/reset countdowns stay live without a global clock. */
function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function Divider() {
  return <span className="hc-statusline__divider" aria-hidden />;
}

/**
 * Bottom-fixed statusline (plan 6, spec Usage Statusline). Text values only; percent/reset math
 * comes from core/poolSummary + core/format, never recomputed here. Click opens AccountsPopover.
 */
export const StatusLine = memo(function StatusLine({ pool, accounts, activeThread, models = [] }: StatusLineProps) {
  const now = useNow();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  const { summary } = pool;
  const total = summary.total;
  const available = summary.available;
  const availLevel = total === 0 ? 'ok' : available === 0 ? 'crit' : available < total ? 'warn' : 'ok';

  const modelId = activeThread ? (activeThread.resolvedModel ?? activeThread.model) : null;
  const modelText = modelId ? modelLabel(modelId, models) : '–';

  let sessionLabel = '–';
  if (activeThread?.sessionStartedAt != null) {
    try {
      // The clock ticks every 30s; never show a negative duration for a session that just started.
      sessionLabel = formatSessionDuration(activeThread.sessionStartedAt, Math.max(now, activeThread.sessionStartedAt));
    } catch {
      sessionLabel = '–';
    }
  }

  return (
    <footer className="app__status hc-statusline tnum" data-testid="statusline">
      <button
        ref={triggerRef}
        type="button"
        className="hc-statusline__trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Pill className="hc-statusline__model" title={modelId ?? undefined}>
          {modelText}
        </Pill>
        <Divider />
        <UsageMeter label="5h" percent={summary.avg.fiveHour} resetsAt={summary.earliestReset.fiveHour} now={now} />
        <Divider />
        <UsageMeter label="wk" percent={summary.avg.sevenDay} resetsAt={summary.earliestReset.sevenDay} now={now} />
        <Divider />
        <UsageMeter label="fable" percent={summary.avg.fable} resetsAt={summary.earliestReset.fable} now={now} />
        <Divider />
        <span className="hc-statusline__segment">
          <span className="hc-statusline__label">session</span>
          <span className="hc-statusline__value">{sessionLabel}</span>
        </span>
        <Divider />
        <UsageMeter label="ctx" percent={activeThread?.ctxPercent ?? null} now={now} width={32} />
        <Divider />
        <span className="hc-statusline__segment hc-statusline__avail">
          <span className={`hc-statusline__dot hc-statusline__dot--${availLevel}`} aria-hidden />
          <span className="hc-statusline__value">
            {available}/{total} avail
          </span>
        </span>
      </button>
      <AccountsPopover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={triggerRef}
        accounts={accounts}
        usageById={pool.usageById}
        activeAccountId={activeThread?.activeAccountId ?? null}
        now={now}
      />
    </footer>
  );
});
