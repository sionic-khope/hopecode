// PermissionCard buttons for an ACP request (plan 2.5): which ones the agent's options can back, and the caption
// under each. Claude requests (no agentOptions) keep the plain three buttons.
import type { PermissionRequest } from '../../../shared/types';

export interface PermissionButtonState {
  allow: { enabled: boolean };
  allowSession: { shown: boolean; caption: string | null; warn: boolean };
  deny: { caption: string | null };
  /** The agent's own option names, in the order it sent them (shown as a quiet line); empty for Claude. */
  agentOptionNames: string[];
}

export const DENY_CANCELS_TURN = '거부 시 이번 턴 전체가 취소될 수 있음';
export const MAY_PERSIST = '에이전트 설정에 따라 이후에도 자동 허용될 수 있음';

export function permissionButtons(request: Pick<PermissionRequest, 'agentOptions' | 'hasSessionSuggestion' | 'sessionLabel'>): PermissionButtonState {
  const options = request.agentOptions;
  if (!options) {
    return {
      allow: { enabled: true },
      allowSession: { shown: request.hasSessionSuggestion, caption: null, warn: false },
      deny: { caption: null },
      agentOptionNames: [],
    };
  }
  const label = request.sessionLabel?.trim() || null;
  const persistent = label !== null && /always|항상/i.test(label) && !/session/i.test(label);
  return {
    allow: { enabled: options.some((o) => o.kind === 'allow_once') },
    allowSession: {
      shown: request.hasSessionSuggestion,
      caption: label === null ? null : persistent ? `${label} · ${MAY_PERSIST}` : label,
      warn: persistent,
    },
    deny: { caption: options.some((o) => o.kind === 'reject_once') ? null : DENY_CANCELS_TURN },
    agentOptionNames: options.map((o) => o.name),
  };
}
