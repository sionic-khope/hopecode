import { memo, useEffect, useRef, useState } from 'react';
import type { Account, ModelOption, PoolSnapshot, Thread } from '../../../shared/types';
import { modelLabel } from '../../../core/modelLabel';
import { codexModelLabel } from '../../../core/modelDisplay';
import { hermesModelChip } from '../Chat/acpChips';
import { formatSessionDuration } from '../../../core/format';
import { Pill } from '../common';
import { AccountsPopover } from '../Accounts/AccountsPopover';
import { useAppStore } from '../../store';
import { UsageMeter } from './UsageMeter';
import { statusLineMode, usageSourceTitle, usageWindowsFor } from './statusLineMode';
import './StatusLine.css';

export interface StatusLineProps {
  pool: PoolSnapshot;
  accounts: Account[];
  /** Thread currently shown in the chat pane; null when nothing is selected. */
  activeThread: Thread | null;
  /** Model options (`models:list`) whose labels replace raw ids. */
  models?: ModelOption[];
  /** Display name of the model in use (thread) or about to be used (draft); overrides the id-derived label. */
  modelText?: string | null;
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
export const StatusLine = memo(function StatusLine({ pool, accounts, activeThread, models = [], modelText: modelTextProp }: StatusLineProps) {
  const now = useNow();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  const { summary } = pool;
  const total = summary.total;
  const available = summary.available;
  const availLevel = total === 0 ? 'ok' : available === 0 ? 'crit' : available < total ? 'warn' : 'ok';

  const hermesInfo = useAppStore((s) => s.localAuth.find((i) => i.agent === 'hermes'));
  const modelId = activeThread ? (activeThread.resolvedModel ?? activeThread.model) : null;
  const agentModelText = (): string | null => {
    if (!activeThread) return null;
    if (activeThread.agent === 'codex' && modelId) return codexModelLabel(modelId, activeThread.acp?.controls?.configOptions ?? []);
    if (activeThread.agent === 'hermes') return hermesModelChip(activeThread.acp?.controls?.reportedModel, hermesInfo).label;
    return null;
  };
  const modelText = modelTextProp ?? agentModelText() ?? (modelId ? modelLabel(modelId, models) : '–');

  let sessionLabel = '–';
  if (activeThread?.sessionStartedAt != null) {
    try {
      // The clock ticks every 30s; never show a negative duration for a session that just started.
      sessionLabel = formatSessionDuration(activeThread.sessionStartedAt, Math.max(now, activeThread.sessionStartedAt));
    } catch {
      sessionLabel = '–';
    }
  }

  const mode = statusLineMode(activeThread);
  const agent = activeThread?.agent ?? 'claude-code';
  const snapshot = useAppStore((st) => st.agentUsage[agent] ?? null);
  const windows = mode === 'agent-usage' ? usageWindowsFor(agent, snapshot) : [];
  const effort = mode === 'pool' ? null : (activeThread?.effort ?? null);

  const modelPill = (
    <Pill className="hc-statusline__model" title={modelId ?? undefined}>
      {modelText}
    </Pill>
  );
  const ctx = <UsageMeter label="ctx" percent={activeThread?.ctxPercent ?? null} now={now} width={32} />;

  if (mode !== 'pool') {
    return (
      <footer className="app__status hc-statusline tnum" data-testid="statusline" data-mode={mode}>
        <div className="hc-statusline__trigger hc-statusline__trigger--static">
          {modelPill}
          {effort ? (
            <>
              <Divider />
              <span className="hc-statusline__segment">
                <span className="hc-statusline__label">effort</span>
                <span className="hc-statusline__value">{effort}</span>
              </span>
            </>
          ) : null}
          {windows.map((w) => (
            <span key={w.label} className="hc-statusline__segment-wrap" title={snapshot ? usageSourceTitle(snapshot) : undefined}>
              <Divider />
              <UsageMeter label={w.label} percent={w.usedPercent} resetsAt={w.resetsAt} now={now} />
            </span>
          ))}
          <Divider />
          {ctx}
        </div>
      </footer>
    );
  }

  return (
    <footer className="app__status hc-statusline tnum" data-testid="statusline" data-mode="pool">
      <button
        ref={triggerRef}
        type="button"
        className="hc-statusline__trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {modelPill}
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
        {ctx}
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
