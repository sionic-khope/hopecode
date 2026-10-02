import { useEffect, useRef, type ReactNode } from 'react';
import type { ChatNode } from '../../../core/subagents';
import { playSfx } from '../../sound/engine';
import { PixelSprite } from './PixelSprite';
import { formatElapsed, stateLabel, useNow } from './SubagentCard';
import { t } from '../../../shared/i18n';
import './Subagents.css';

/** Overlays an Escape belongs to (they close first; the subagent view stays). */
const OVERLAY = '.hc-popover, .hc-modal, .hc-palette, [role="menu"], [role="dialog"], [role="listbox"]';

export interface SubagentDetailProps {
  node: Extract<ChatNode, { kind: 'subagent' }>;
  /** Back to the main conversation (breadcrumb, Escape). */
  onBack: () => void;
  /** Renders one child node (text, tool card, nested subagent card) at full width. */
  renderChild: (child: ChatNode) => ReactNode;
}

/**
 * One subagent's own conversation in the main area (Codex desktop style): breadcrumb back to the main chat, its
 * character / type / state / elapsed time, the prompt it was given, everything it did, and its final report. Live
 * while it runs (the node is rebuilt from the thread items on every update).
 */
export function SubagentDetail({ node, onBack, renderChild }: SubagentDetailProps) {
  const { summary, children, item } = node;
  const running = summary.state === 'running';
  const now = useNow(running);
  const elapsed = (summary.endedAt ?? now) - summary.startedAt;
  const prompt = typeof item.input.prompt === 'string' ? item.input.prompt : '';
  const report = !running && item.result ? item.result : null;
  const backRef = useRef<HTMLButtonElement>(null);
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;

  useEffect(() => {
    backRef.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing || e.defaultPrevented) return;
      if (document.querySelector(OVERLAY)) return;
      e.preventDefault();
      playSfx('back');
      onBackRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [item.toolUseId]);

  return (
    <section
      className={`hc-subview hc-subview--${summary.state}`}
      data-testid="subagent-detail"
      data-state={summary.state}
      data-tool-id={item.toolUseId}
      aria-label={t('subagent.aria', { type: summary.subagentType })}
    >
      <header className="hc-subview__bar">
        <button
          ref={backRef}
          type="button"
          className="hc-subview__back"
          data-testid="subagent-back"
          data-sfx="back"
          aria-label={t('subagent.back')}
          onClick={onBack}
        >
          <span aria-hidden>←</span> {t('subagent.main')}
        </button>
        <span className="hc-subview__crumb" aria-hidden>
          /
        </span>
        <PixelSprite type={summary.subagentType} size={24} running={running} state={running ? undefined : summary.state === 'done' ? 'done' : 'failed'} />
        <span className="hc-subview__name">{summary.subagentType}</span>
        {summary.description ? <span className="hc-subview__desc">{summary.description}</span> : null}
        <span className="hc-subagent__spacer" />
        <span className={`hc-subagent__state hc-subagent__state--${summary.state}`} data-testid="subagent-detail-state">
          {stateLabel(summary.state)}
        </span>
        <span className="hc-subagent__meta" data-testid="subagent-detail-elapsed">
          {formatElapsed(elapsed)}
        </span>
        <span className="hc-subagent__meta">{t('md.tool')} {summary.childToolCount}</span>
      </header>

      {prompt ? (
        <div className="hc-subview__prompt" data-testid="subagent-detail-prompt">
          <span className="hc-subagent__report-label">{t('subagent.prompt')}</span>
          <p className="hc-subagent__report-text">{prompt}</p>
        </div>
      ) : null}

      <div className="hc-subview__body">
        {children.map((child) => (
          <div key={child.item.id} className="hc-subview__child">
            {renderChild(child)}
          </div>
        ))}
        {children.length === 0 && !report ? (
          <div className="hc-subagent__empty">{running ? t('subagent.starting') : t('subagent.noWork')}</div>
        ) : null}
      </div>

      {report ? (
        <div className="hc-subagent__report hc-subview__report" data-testid="subagent-detail-report">
          <span className="hc-subagent__report-label">{t('subagent.result')}</span>
          <p className="hc-subagent__report-text">{report}</p>
        </div>
      ) : running ? (
        <div className="hc-subview__running" role="status">
          {t('status.running')} · {formatElapsed(elapsed)}
        </div>
      ) : null}
    </section>
  );
}
