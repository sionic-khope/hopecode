// Agent registry: every AgentKind the app can run a thread with. The renderer builds the agent picker from
// AGENT_KINDS, main's SessionManager picks the runner by `thread.agent`. Adding an agent = a new AgentKind member,
// an entry here and a runner branch in main (sessionManager.createRunner); nothing else switches on the kind.
import type { AgentKind } from './types';

export interface AgentFeatures {
  /** Sessions run in a per-thread git worktree when the setting allows it. */
  worktree: boolean;
  /** Permission modes (default / plan / acceptEdits / bypass) apply. */
  permissionModes: boolean;
  /** Reasoning effort levels apply. */
  effort: boolean;
  /** Turns rotate across the Claude account pool. */
  accountRotation: boolean;
  /** Model picker (models:list). */
  modelPicker: boolean;
}

export interface AgentDescriptor {
  id: AgentKind;
  /** Display name. */
  name: string;
  /** One-line description for the picker. */
  description: string;
  /**
   * Optional logo under src/renderer/assets/ (e.g. `agents/claude-code.svg`). Loaded only if the file exists;
   * otherwise the renderer shows a neutral Hopecode glyph next to the name.
   */
  iconAsset: string;
  features: AgentFeatures;
}

export const DEFAULT_AGENT: AgentKind = 'claude-code';

export const AGENTS: Readonly<Record<AgentKind, AgentDescriptor>> = {
  'claude-code': {
    id: 'claude-code',
    name: 'Claude Code',
    description: 'Claude 계정 풀로 실행되는 코딩 에이전트',
    iconAsset: 'agents/claude-code.svg',
    features: { worktree: true, permissionModes: true, effort: true, accountRotation: true, modelPicker: true },
  },
};

export const AGENT_KINDS: readonly AgentKind[] = Object.keys(AGENTS) as AgentKind[];

export function isAgentKind(v: unknown): v is AgentKind {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(AGENTS, v);
}

export function agentDescriptor(kind: AgentKind): AgentDescriptor {
  return AGENTS[kind];
}
