import { hermesModelLabel } from '../../../core/hermesModelLabel';
import type { LocalAuthInfo, LocalAuthState } from '../../../shared/types';

export interface LocalAuthView {
  stateLabel: string;
  tone: 'ok' | 'warn' | 'crit' | 'neutral';
  /** email · plan, when known. */
  identity: string | null;
  /** Where the login was found (a path / keychain label; not a secret). */
  source: string | null;
  /** Hermes: system default model (`DeepSeek V4.1 Flash Ultrafast · og`). */
  defaultModel: string | null;
  /** Codex: the engine executable and its version (`/Applications/ChatGPT.app/…/codex · codex-cli 0.159.2`). */
  engine: string | null;
}

const STATE_LABEL: Record<LocalAuthState, { label: string; tone: LocalAuthView['tone'] }> = {
  'logged-in': { label: '로그인됨', tone: 'ok' },
  'logged-out': { label: '미로그인', tone: 'warn' },
  'not-installed': { label: '미설치', tone: 'neutral' },
  error: { label: '확인 실패', tone: 'crit' },
};

/** Display model for the "이 Mac에서 감지됨" card. Only whitelisted fields are read -- nothing token-like can leak. */
export function localAuthView(info: LocalAuthInfo | undefined): LocalAuthView {
  if (!info) return { stateLabel: '확인 중', tone: 'neutral', identity: null, source: null, defaultModel: null, engine: null };
  const s = STATE_LABEL[info.state];
  const identity = [info.email, info.plan].filter((v): v is string => !!v).join(' · ') || null;
  const provider = info.provider && info.agent === 'hermes' ? `provider: ${info.provider}` : null;
  const defaultModel = info.agent === 'hermes' && info.defaultModel
    ? `${hermesModelLabel(info.defaultModel)}${info.defaultProvider ? ` · ${info.defaultProvider}` : ''}`
    : null;
  const engine = info.agent === 'codex' && info.enginePath ? `${info.enginePath}${info.version ? ` · codex-cli ${info.version}` : ''}` : null;
  return { stateLabel: s.label, tone: s.tone, identity: identity ?? provider, source: info.source || null, defaultModel, engine };
}

/** How to log in for agents that sign in from their own CLI. */
export const CLI_LOGIN_HINT: Record<'codex' | 'hermes', string[]> = {
  codex: ['codex login'],
  hermes: ['hermes setup', 'hermes auth'],
};
