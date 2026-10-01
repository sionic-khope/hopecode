import type { ReactNode } from 'react';
import { agentDescriptor } from '../../../shared/agents';
import type { AgentKind } from '../../../shared/types';
import { AgentIcon } from '../Agent/AgentIcon';

export interface AgentSectionProps {
  agent: AgentKind;
  /** Right side of the heading (e.g. "+ 계정 추가"). */
  actions?: ReactNode;
  children: ReactNode;
}

/** One agent's block on the Accounts page: heading + "이 Mac에서 감지됨" card + agent-specific body. */
export function AgentSection({ agent, actions, children }: AgentSectionProps) {
  const d = agentDescriptor(agent);
  return (
    <section className="hc-agent-section" aria-labelledby={`hc-agent-section-${agent}`} data-testid={`agent-section-${agent}`}>
      <header className="hc-agent-section__head">
        <AgentIcon kind={agent} size={16} />
        <h2 className="hc-agent-section__title" id={`hc-agent-section-${agent}`}>
          {d.name}
        </h2>
        {actions ? <div className="hc-agent-section__actions">{actions}</div> : null}
      </header>
      {children}
    </section>
  );
}
