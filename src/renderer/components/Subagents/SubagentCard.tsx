import { createContext, memo, useContext, useEffect, useState, type ReactNode } from 'react';
import type { ChatNode, SubagentState, SubagentSummary } from '../../../core/subagents';
import { Collapse } from '../common';
import { ChevronIcon } from '../Chat/icons';
import { PixelSprite } from './PixelSprite';
import { useLanguage } from '../../i18n';
import { t, type MessageKey } from '../../../shared/i18n';
import './Subagents.css';

const STATE_KEY: Record<SubagentState, MessageKey> = { running: 'status.running', done: 'status.done', failed: 'tool.failed' };
export const stateLabel = (state: SubagentState): string => t(STATE_KEY[state]);

/** Opens a subagent's own transcript in the main area (MessageList provides it; absent = no detail view). */
export const SubagentNavContext = createContext<((toolUseId: string) => void) | null>(null);

/** "8초", "1분 5초", "1시간 2분". */
export function formatElapsed(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return t('elapsed.s', { s: sec });
  const min = Math.floor(sec / 60);
  if (min < 60) return sec % 60 ? t('elapsed.ms', { m: min, s: sec % 60 }) : t('elapsed.m', { m: min });
  const hours = Math.floor(min / 60);
  return min % 60 ? t('elapsed.hm', { h: hours, m: min % 60 }) : t('elapsed.h', { h: hours });
}

/** Wall clock that ticks every second while `live`. */
export function useNow(live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [live]);
  return now;
}

export interface SubagentCardProps {
  node: Extract<ChatNode, { kind: 'subagent' }>;
  /** Renders one child node (text, tool card, nested subagent) inside the expanded card. */
  renderChild: (child: ChatNode) => ReactNode;
}

/**
 * Card of one subagent run (Task/Agent tool_use): pixel character, type, task, state, elapsed time, tool count on
 * one line; expands to the subagent's own messages and tool calls, indented.
 */
export const SubagentCard = memo(function SubagentCard({ node, renderChild }: SubagentCardProps) {
  useLanguage();
  const { summary, children, item } = node;
  const [open, setOpen] = useState(false);
  const openDetail = useContext(SubagentNavContext);
  const running = summary.state === 'running';
  const now = useNow(running);
  const elapsed = (summary.endedAt ?? now) - summary.startedAt;
  const settled = summary.state === 'running' ? undefined : summary.state;
  const report = !running && item.result && item.taskStatus === undefined ? item.result : null;

  return (
    <div
      className={`hc-subagent hc-subagent--${summary.state}${open ? ' hc-subagent--open' : ''}`}
      data-testid="subagent-card"
      data-state={summary.state}
      data-tool-id={item.toolUseId}
    >
      <div className="hc-subagent__bar">
        <button type="button" className="hc-subagent__header" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <PixelSprite type={summary.subagentType} size={24} running={running} state={settled} />
          <span className="hc-subagent__type">{summary.subagentType}</span>
          {summary.description ? <span className="hc-subagent__desc">{summary.description}</span> : null}
          <span className="hc-subagent__spacer" />
          <span className={`hc-subagent__state hc-subagent__state--${summary.state}`}>{stateLabel(summary.state)}</span>
          <span className="hc-subagent__meta">{formatElapsed(elapsed)}</span>
          <span className="hc-subagent__meta" data-testid="subagent-tool-count">
            {t('md.tool')} {summary.childToolCount}
          </span>
          <span className="hc-subagent__chevron">
            <ChevronIcon width={13} height={13} />
          </span>
        </button>
        {openDetail ? (
          <button
            type="button"
            className="hc-subagent__open"
            data-testid="subagent-open"
            aria-label={t('subagent.viewAria', { type: summary.subagentType })}
            title={t('subagent.view')}
            onClick={() => openDetail(item.toolUseId)}
          >
            {t('subagent.viewShort')}
            <ChevronIcon width={11} height={11} className="hc-subagent__open-icon" />
          </button>
        ) : null}
      </div>
      <Collapse open={open}>
        <div className="hc-subagent__body">
          {children.length === 0 && !report ? <div className="hc-subagent__empty">{t('subagent.noWorkYet')}</div> : null}
          {children.map((child) => (
            <div key={child.item.id} className="hc-subagent__child">
              {renderChild(child)}
            </div>
          ))}
          {report ? (
            <div className="hc-subagent__report">
              <span className="hc-subagent__report-label">{t('subagent.result')}</span>
              <p className="hc-subagent__report-text">{report}</p>
            </div>
          ) : null}
        </div>
      </Collapse>
    </div>
  );
});

/** PARTY line over a turn's subagent cards: their characters in a row and "서브에이전트 N개 실행 중". */
export function SubagentRouting({ subagents }: { subagents: SubagentSummary[] }) {
  useLanguage();
  const openDetail = useContext(SubagentNavContext);
  if (subagents.length === 0) return null;
  const running = subagents.filter((s) => s.state === 'running').length;
  const failed = subagents.filter((s) => s.state === 'failed').length;
  const label =
    running > 0
      ? `${t('subagent.running', { count: running })}${subagents.length > running ? ` · ${t('subagent.doneN', { count: subagents.length - running })}` : ''}`
      : `${t('subagent.allDone', { count: subagents.length })}${failed > 0 ? ` · ${t('tool.failed')} ${failed}` : ''}`;
  return (
    <div className="hc-subagent-routing" data-testid="subagent-routing" role="status">
      <span className="hc-subagent-routing__party" aria-hidden>
        PARTY
      </span>
      <span className="hc-subagent-routing__sprites">
        {subagents.map((s) =>
          openDetail ? (
            <button
              key={s.toolUseId}
              type="button"
              className="hc-subagent-routing__member"
              data-testid="subagent-party-member"
              aria-label={t('subagent.viewChat', { name: `${s.subagentType}${s.description ? ` · ${s.description}` : ''}` })}
              title={s.description || s.subagentType}
              onClick={() => openDetail(s.toolUseId)}
            >
              <PixelSprite type={s.subagentType} size={24} running={s.state === 'running'} />
            </button>
          ) : (
            <PixelSprite key={s.toolUseId} type={s.subagentType} size={24} running={s.state === 'running'} />
          ),
        )}
      </span>
      <span className="hc-subagent-routing__label">{label}</span>
      <span className="hc-subagent-routing__types">{[...new Set(subagents.map((s) => s.subagentType))].join(' · ')}</span>
    </div>
  );
}
