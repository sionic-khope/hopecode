import { useState } from 'react';
import type { AgentKind, LocalAuthInfo } from '../../../shared/types';
import { Button, Pill } from '../common';
import { ipcErrorMessage } from '../../errors';
import { localAuthView } from './localAuthView';

export interface LocalAuthCardProps {
  agent: AgentKind;
  info: LocalAuthInfo | undefined;
  /** `agents:recheck` for this agent. */
  onRecheck: (agent: AgentKind) => Promise<unknown>;
}

/** "이 Mac에서 감지됨": login state, email, plan and where it was found. Never shows a token. */
export function LocalAuthCard({ agent, info, onRecheck }: LocalAuthCardProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const view = localAuthView(info);

  const recheck = () => {
    setBusy(true);
    setError(null);
    onRecheck(agent)
      .catch((err: unknown) => setError(ipcErrorMessage(err)))
      .finally(() => setBusy(false));
  };

  return (
    <div className="hc-local-auth" data-testid={`local-auth-${agent}`} data-state={info?.state ?? 'unknown'}>
      <div className="hc-local-auth__head">
        <span className="hc-local-auth__title">이 Mac에서 감지됨</span>
        <Pill tone={view.tone} capsule data-testid={`local-auth-state-${agent}`}>
          {view.stateLabel}
        </Pill>
        <Button variant="plain" size="sm" disabled={busy} onClick={recheck} data-testid={`local-auth-recheck-${agent}`}>
          {busy ? '확인 중…' : '재확인'}
        </Button>
      </div>
      {view.identity || view.source || view.defaultModel ? (
        <dl className="hc-local-auth__kv">
          {view.identity ? (
            <>
              <dt>계정</dt>
              <dd>{view.identity}</dd>
            </>
          ) : null}
          {view.defaultModel ? (
            <>
              <dt>기본 모델</dt>
              <dd data-testid={`local-auth-model-${agent}`}>{view.defaultModel}</dd>
            </>
          ) : null}
          {view.source ? (
            <>
              <dt>출처</dt>
              <dd>
                <code>{view.source}</code>
              </dd>
            </>
          ) : null}
        </dl>
      ) : null}
      {info?.detail && info.state !== 'logged-in' ? <p className="hc-local-auth__detail">{info.detail}</p> : null}
      {error ? (
        <p className="hc-local-auth__detail hc-local-auth__detail--error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
