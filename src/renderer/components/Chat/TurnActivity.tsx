import { useEffect, useState } from 'react';
import type { AgentKind } from '../../../shared/types';
import { AGENTS } from '../../../shared/agents';
import type { TurnPhaseKind } from '../../store';
import { AgentIcon } from '../Agent/AgentIcon';
import { formatElapsed } from './agentIssues';
import './Chat.css';

/** Wall clock that ticks every `intervalMs` while `active` (elapsed labels). */
export function useTicker(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [active, intervalMs]);
  return now;
}

/** Status line of a turn phase ("Codex 세션 준비 중…"). */
export function turnPhaseLabel(phase: TurnPhaseKind, agent: AgentKind): string {
  switch (phase) {
    case 'preparing':
      return `${AGENTS[agent].name} 세션 준비 중…`;
    case 'loading':
      return '이전 대화 불러오는 중…';
    case 'switching':
      return '다른 계정으로 전환하는 중…';
    default:
      return '생각하는 중…';
  }
}

export interface TurnActivityProps {
  agent: AgentKind;
  phase: TurnPhaseKind;
  /** epoch ms the turn started (elapsed timer). */
  startedAt: number;
}

/**
 * The agent's slot while a turn runs with nothing streaming: avatar with a soft breathing ring, a shimmering status
 * line and the turn's elapsed time. Appears after a short delay so a quick hand-off between outputs does not flash.
 */
export function TurnActivity({ agent, phase, startedAt }: TurnActivityProps) {
  const now = useTicker(true);
  const label = turnPhaseLabel(phase, agent);
  return (
    <div className="hc-agent-row hc-agent-row--lead hc-activity" data-testid="turn-activity" data-phase={phase}>
      <span className="hc-agent-row__avatar">
        <span className="hc-agent-avatar hc-activity__avatar" title={AGENTS[agent].name} aria-label={AGENTS[agent].name} role="img">
          <AgentIcon kind={agent} size={22} />
        </span>
      </span>
      <div className="hc-agent-row__body hc-activity__body">
        <span className="hc-activity__label" data-text={label} role="status" aria-live="polite">
          {label}
        </span>
        {/* Ticks every second: kept out of the live region so screen readers hear the phase, not the clock. */}
        <span className="hc-activity__elapsed" data-testid="turn-elapsed" aria-hidden>
          {formatElapsed(now - startedAt)}
        </span>
      </div>
    </div>
  );
}
