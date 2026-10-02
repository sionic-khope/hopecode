import { useState } from 'react';
import type { AgentKind, LocalAuthInfo } from '../../../shared/types';
import { Button, Pill } from '../common';
import { ipcErrorMessage } from '../../errors';
import { localAuthView } from './localAuthView';
import { t } from '../../../shared/i18n';

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
        <span className="hc-local-auth__title">{t('localAuth.detected')}</span>
        <Pill tone={view.tone} capsule data-testid={`local-auth-state-${agent}`}>
          {view.stateLabel}
        </Pill>
        <Button variant="plain" size="sm" disabled={busy} onClick={recheck} data-testid={`local-auth-recheck-${agent}`}>
          {busy ? t('localAuth.checkingEllipsis') : t('localAuth.recheck')}
        </Button>
      </div>
      {view.identity || view.source || view.defaultModel || view.engine ? (
        <dl className="hc-local-auth__kv">
          {view.identity ? (
            <>
              <dt>{t('localAuth.account')}</dt>
              <dd>{view.identity}</dd>
            </>
          ) : null}
          {view.defaultModel ? (
            <>
              <dt>{t('settings.defaultModel')}</dt>
              <dd data-testid={`local-auth-model-${agent}`}>{view.defaultModel}</dd>
            </>
          ) : null}
          {view.engine ? (
            <>
              <dt>{t('localAuth.engine')}</dt>
              <dd data-testid={`local-auth-engine-${agent}`}>
                <code>{view.engine}</code>
              </dd>
            </>
          ) : null}
          {view.source ? (
            <>
              <dt>{t('localAuth.source')}</dt>
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
