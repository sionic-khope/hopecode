import { agentDescriptor } from '../../../shared/agents';
import type { AgentKind, AgentUsageSnapshot, Thread } from '../../../shared/types';

/**
 * What the statusline shows for the selected thread's agent.
 * - `pool`: Claude, the account pool meters + accounts popover (no thread = draft = Claude pool as before).
 * - `agent-usage`: the agent reports its own limit windows (Hermes); hidden while there is no snapshot.
 * - `basic`: model / effort / ctx only (Codex v1 shows no limits).
 */
export type StatusLineMode = 'pool' | 'agent-usage' | 'basic';

export function statusLineMode(thread: Pick<Thread, 'agent'> | null): StatusLineMode {
  if (!thread) return 'pool';
  switch (agentDescriptor(thread.agent).usageSource) {
    case 'claude-pool':
      return 'pool';
    case 'hermes':
      return 'agent-usage';
    default:
      return 'basic';
  }
}

/** Windows worth drawing for a snapshot of the thread's agent; empty = hide the meters. */
export function usageWindowsFor(agent: AgentKind, snapshot: AgentUsageSnapshot | null | undefined) {
  if (!snapshot || snapshot.agent !== agent) return [];
  return snapshot.windows;
}

/** Tooltip naming where the numbers come from (provider / plan), never a credential. */
export function usageSourceTitle(snapshot: AgentUsageSnapshot): string {
  const parts = [snapshot.title ?? snapshot.provider ?? 'Hermes', snapshot.plan].filter(Boolean);
  return `출처: hermes usage · ${parts.join(' · ')}`;
}
