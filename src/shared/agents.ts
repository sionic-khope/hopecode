// Agent registry: every AgentKind the app can run a thread with. The renderer builds the agent picker from
// AGENT_KINDS, main's SessionManager picks the runner by `thread.agent` (`features.runtime`). Adding an agent = a new
// AgentKind member, an entry here and a runner factory in main (sessionManager runnerFactories).
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
  /** Claude model picker (models:list). ACP model / effort chips come from the session's config options instead. */
  modelPicker: boolean;
  /** How sessions run: Claude Agent SDK Query, or an ACP agent process over stdio. */
  runtime: 'claude-sdk' | 'acp';
  /** The composer shows the ACP session-mode chip (the agent's own modes). */
  agentModes: boolean;
}

export interface AgentDescriptor {
  id: AgentKind;
  /** Display name. */
  name: string;
  /** Picker sub-line: vendor · new-chat default model (short; menu rows ellipsize). */
  description: string;
  /**
   * Optional logo under src/renderer/assets/ (e.g. `agents/claude-code.svg`). Loaded only if the file exists;
   * otherwise the renderer shows a neutral deltax glyph next to the name.
   */
  iconAsset: string;
  features: AgentFeatures;
  /** Where account usage comes from: the Claude pool poller, `hermes usage --json`, or nowhere (meters hidden). */
  usageSource: 'claude-pool' | 'hermes' | 'none';
  /** New-chat model / effort: from AppSettings (per agent), or the agent's own system default (never set by the app). */
  defaults: 'settings' | 'system';
}

export const DEFAULT_AGENT: AgentKind = 'claude-code';

export const AGENTS: Readonly<Record<AgentKind, AgentDescriptor>> = {
  'claude-code': {
    id: 'claude-code',
    name: 'Claude Code',
    description: 'Anthropic · Opus 5.5',
    iconAsset: 'agents/claude-code.svg',
    features: {
      worktree: true,
      permissionModes: true,
      effort: true,
      accountRotation: true,
      modelPicker: true,
      runtime: 'claude-sdk',
      agentModes: false,
    },
    usageSource: 'claude-pool',
    defaults: 'settings',
  },
  codex: {
    id: 'codex',
    name: 'Codex',
    description: 'OpenAI · GPT-6.1-Sol',
    iconAsset: 'agents/codex.svg',
    // permissionModes: the app permission chip maps to codex `-c approval_policy / sandbox_mode` (plan 2.15).
    // Model / effort chips come from ACP config options, not modelPicker / effort.
    features: {
      worktree: true,
      permissionModes: true,
      effort: false,
      accountRotation: false,
      modelPicker: false,
      runtime: 'acp',
      agentModes: false,
    },
    // v1 shows no Codex limits (Hermes' pool account may differ from ~/.codex).
    usageSource: 'none',
    defaults: 'settings',
  },
  hermes: {
    id: 'hermes',
    name: 'Hermes',
    description: 'Nous Research · 시스템 기본 모델',
    iconAsset: 'agents/hermes.svg',
    features: {
      worktree: true,
      permissionModes: false,
      effort: false,
      accountRotation: false,
      modelPicker: false,
      runtime: 'acp',
      agentModes: true,
    },
    usageSource: 'hermes',
    defaults: 'system',
  },
};

export const AGENT_KINDS: readonly AgentKind[] = Object.keys(AGENTS) as AgentKind[];

export function isAgentKind(v: unknown): v is AgentKind {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(AGENTS, v);
}

export function agentDescriptor(kind: AgentKind): AgentDescriptor {
  return AGENTS[kind];
}
