import { memo, useEffect, useState, type ReactNode } from 'react';
import type { ChatNode, SubagentState, SubagentSummary } from '../../../core/subagents';
import { Collapse } from '../common';
import { ChevronIcon } from '../Chat/icons';
import { PixelSprite } from './PixelSprite';
import './Subagents.css';

const STATE_LABEL: Record<SubagentState, string> = { running: '실행 중', done: '완료', failed: '실패' };

/** "8초", "1분 5초", "1시간 2분". */
export function formatElapsed(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec}초`;
  const min = Math.floor(sec / 60);
  if (min < 60) return sec % 60 ? `${min}분 ${sec % 60}초` : `${min}분`;
  const hours = Math.floor(min / 60);
  return min % 60 ? `${hours}시간 ${min % 60}분` : `${hours}시간`;
}

/** Wall clock that ticks every second while `live`. */
function useNow(live: boolean): number {
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
  const { summary, children, item } = node;
  const [open, setOpen] = useState(false);
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
      <button type="button" className="hc-subagent__header" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <PixelSprite type={summary.subagentType} size={24} running={running} state={settled} />
        <span className="hc-subagent__type">{summary.subagentType}</span>
        {summary.description ? <span className="hc-subagent__desc">{summary.description}</span> : null}
        <span className="hc-subagent__spacer" />
        <span className={`hc-subagent__state hc-subagent__state--${summary.state}`}>{STATE_LABEL[summary.state]}</span>
        <span className="hc-subagent__meta">{formatElapsed(elapsed)}</span>
        <span className="hc-subagent__meta" data-testid="subagent-tool-count">
          도구 {summary.childToolCount}
        </span>
        <span className="hc-subagent__chevron">
          <ChevronIcon width={13} height={13} />
        </span>
      </button>
      <Collapse open={open}>
        <div className="hc-subagent__body">
          {children.length === 0 && !report ? <div className="hc-subagent__empty">아직 하위 작업이 없습니다</div> : null}
          {children.map((child) => (
            <div key={child.item.id} className="hc-subagent__child">
              {renderChild(child)}
            </div>
          ))}
          {report ? (
            <div className="hc-subagent__report">
              <span className="hc-subagent__report-label">결과</span>
              <p className="hc-subagent__report-text">{report}</p>
            </div>
          ) : null}
        </div>
      </Collapse>
    </div>
  );
});

/** "서브에이전트 N개 실행 중" line over a turn's subagent cards (their characters in a row). */
export function SubagentRouting({ subagents }: { subagents: SubagentSummary[] }) {
  if (subagents.length === 0) return null;
  const running = subagents.filter((s) => s.state === 'running').length;
  const failed = subagents.filter((s) => s.state === 'failed').length;
  const label =
    running > 0
      ? `서브에이전트 ${running}개 실행 중${subagents.length > running ? ` · ${subagents.length - running}개 완료` : ''}`
      : `서브에이전트 ${subagents.length}개 완료${failed > 0 ? ` · 실패 ${failed}` : ''}`;
  return (
    <div className="hc-subagent-routing" data-testid="subagent-routing" role="status">
      <span className="hc-subagent-routing__sprites">
        {subagents.map((s) => (
          <PixelSprite
            key={s.toolUseId}
            type={s.subagentType}
            size={24}
            running={s.state === 'running'}
          />
        ))}
      </span>
      <span className="hc-subagent-routing__label">{label}</span>
      <span className="hc-subagent-routing__types">{[...new Set(subagents.map((s) => s.subagentType))].join(' · ')}</span>
    </div>
  );
}
