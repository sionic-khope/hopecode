// Agent picker rows: whether each agent can start a chat on this Mac, and the reason line shown when it cannot.
// Mirrors main's LocalAuthService.availability(); Claude Code runs on the account pool, so its own local login
// never disables it.
import { hermesModelLabel } from '../../../core/hermesModelLabel';
import { AGENT_KINDS, AGENTS } from '../../../shared/agents';
import type { AgentAvailability, AgentKind, LocalAuthInfo } from '../../../shared/types';
import { t, type MessageKey } from '../../../shared/i18n';

export interface AgentMenuRow {
  agent: AgentKind;
  name: string;
  disabled: boolean;
  /** Reason line under the name: the agent's description when usable, else what is missing and how to fix it. */
  description: string;
  reason: AgentAvailability['reason'] | 'checking';
}

/** Short (menu rows ellipsize): the command that logs in. */
const LOGIN_HINT: Partial<Record<AgentKind, MessageKey>> = {
  codex: 'agentMenu.login.codex',
  hermes: 'agentMenu.login.hermes',
};

const INSTALL_HINT: Partial<Record<AgentKind, MessageKey>> = {
  codex: 'agentMenu.install.codex',
  hermes: 'agentMenu.install.hermes',
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
  if (!a) return { agent, name, disabled: true, reason: 'checking', description: t('agentMenu.checking') };
  switch (a.reason) {
    case 'ok': {
      const defaultModel = agent === 'hermes' ? localAuth.find((i) => i.agent === agent)?.defaultModel : null;
      const description = defaultModel ? `Nous Research · ${hermesModelLabel(defaultModel)}` : AGENTS[agent].description;
      return { agent, name, disabled: false, reason: 'ok', description };
    }
    case 'not-installed':
      return { agent, name, disabled: true, reason: a.reason, description: `${t('agentMenu.notInstalled')} · ${t(INSTALL_HINT[agent] ?? 'agentMenu.install.generic')}` };
    case 'not-logged-in':
      return { agent, name, disabled: true, reason: a.reason, description: `${t('agentMenu.loginRequired')} · ${t(LOGIN_HINT[agent] ?? 'agentMenu.login.generic')}` };
    default:
      return { agent, name, disabled: true, reason: a.reason, description: t('agentMenu.error') };
  }
}

/** Every agent row of the picker, in registry order. */
export function agentMenuState(localAuth: readonly LocalAuthInfo[]): AgentMenuRow[] {
  return AGENT_KINDS.map((agent) => agentMenuRow(agent, localAuth));
}
