// Agent picker rows: whether each agent can start a chat on this Mac, and the reason line shown when it cannot.
// Mirrors main's LocalAuthService.availability(); Claude Code runs on the account pool, so its own local login
// never disables it.
import { AGENT_KINDS, AGENTS } from '../../../shared/agents';
import type { AgentAvailability, AgentKind, LocalAuthInfo } from '../../../shared/types';

export interface AgentMenuRow {
  agent: AgentKind;
  name: string;
  disabled: boolean;
  /** Reason line under the name: the agent's description when usable, else what is missing and how to fix it. */
  description: string;
  reason: AgentAvailability['reason'] | 'checking';
}

/** Short (menu rows ellipsize): the command that logs in. */
const LOGIN_HINT: Partial<Record<AgentKind, string>> = {
  codex: 'npx @openai/codex login',
  hermes: '터미널에서 hermes auth',
};

const INSTALL_HINT: Partial<Record<AgentKind, string>> = {
  codex: 'codex-acp를 찾지 못함',
  hermes: 'hermes CLI를 설치하세요',
};

/** One agent's availability from the local login detection (`localAuth`). */
export function agentAvailability(agent: AgentKind, localAuth: readonly LocalAuthInfo[]): AgentAvailability | null {
  if (AGENTS[agent].features.accountRotation) return { agent, usable: true, reason: 'ok' };
  const info = localAuth.find((i) => i.agent === agent);
  if (!info) return null;
  if (info.state === 'logged-in') return { agent, usable: true, reason: 'ok' };
  if (info.state === 'not-installed') return { agent, usable: false, reason: 'not-installed' };
  if (info.state === 'logged-out') return { agent, usable: false, reason: 'not-logged-in' };
  return { agent, usable: false, reason: 'error' };
}

export function agentMenuRow(agent: AgentKind, localAuth: readonly LocalAuthInfo[]): AgentMenuRow {
  const name = AGENTS[agent].name;
  const a = agentAvailability(agent, localAuth);
  if (!a) return { agent, name, disabled: true, reason: 'checking', description: '설치·로그인 상태 확인 중' };
  switch (a.reason) {
    case 'ok':
      return { agent, name, disabled: false, reason: 'ok', description: AGENTS[agent].description };
    case 'not-installed':
      return { agent, name, disabled: true, reason: a.reason, description: `설치되지 않음 · ${INSTALL_HINT[agent] ?? '설치 후 다시 확인'}` };
    case 'not-logged-in':
      return { agent, name, disabled: true, reason: a.reason, description: `로그인 필요 · ${LOGIN_HINT[agent] ?? '로그인 후 다시 확인'}` };
    default:
      return { agent, name, disabled: true, reason: a.reason, description: '상태를 확인하지 못함 · 다시 확인' };
  }
}

/** Every agent row of the picker, in registry order. */
export function agentMenuState(localAuth: readonly LocalAuthInfo[]): AgentMenuRow[] {
  return AGENT_KINDS.map((agent) => agentMenuRow(agent, localAuth));
}
