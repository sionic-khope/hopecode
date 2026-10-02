import { useEffect, useRef } from 'react';
import type { PermissionDecision, PermissionRequest } from '../../../shared/types';
import { Button } from '../common';
import { permissionButtons } from './permissionButtons';
import { t } from '../../../shared/i18n';
import './Chat.css';

export interface PermissionCardProps {
  request: PermissionRequest;
  onDecide: (requestId: string, decision: PermissionDecision) => void;
}

function formatInput(input: Record<string, unknown>): string {
  const entries = Object.entries(input);
  if (entries.length === 0) return '';
  // Prefer a single dominant field (command/path/pattern) rendered raw; else pretty JSON.
  for (const key of ['command', 'file_path', 'pattern', 'url', 'description']) {
    const v = input[key];
    if (typeof v === 'string') return v;
  }
  return JSON.stringify(input, null, 2);
}

/**
 * Allow / Allow for session / Deny card shown before a tool runs (plan 4.4, permissionBroker). ACP requests carry the
 * agent's own options: a button the agent offers nothing for is disabled, and the captions say what the agent will
 * actually do with the choice.
 */
export function PermissionCard({ request, onDecide }: PermissionCardProps) {
  const denyRef = useRef<HTMLButtonElement>(null);
  const allowRef = useRef<HTMLButtonElement>(null);
  const buttons = permissionButtons(request);

  useEffect(() => {
    if (request.defaultToNo || !buttons.allow.enabled) denyRef.current?.focus();
    else allowRef.current?.focus();
  }, [request.defaultToNo, buttons.allow.enabled]);

  const inputPreview = formatInput(request.input);
  const captions = buttons.allowSession.caption || buttons.deny.caption;

  return (
    <div className="hc-permission" role="alertdialog" aria-label={request.title ?? request.toolName}>
      <div className="hc-permission__title" data-badge={t('perm.badge')}>{t('notify.permission.body', { tool: request.displayName ?? request.toolName })}</div>
      {request.description ? <div className="hc-permission__desc">{request.description}</div> : null}
      {inputPreview ? <pre className="hc-permission__input">{inputPreview}</pre> : null}
      <div className="hc-permission__actions">
        <Button
          ref={allowRef}
          variant="primary"
          size="sm"
          disabled={!buttons.allow.enabled}
          title={buttons.allow.enabled ? undefined : t('perm.allowOnceMissing')}
          onClick={() => onDecide(request.requestId, 'allow')}
        >
          {t('perm.allow')}
        </Button>
        {buttons.allowSession.shown ? (
          <Button variant="secondary" size="sm" onClick={() => onDecide(request.requestId, 'allow-session')}>
            {t('perm.allowSession')}
          </Button>
        ) : null}
        <Button ref={denyRef} variant="destructive" size="sm" onClick={() => onDecide(request.requestId, 'deny')}>
          {t('perm.deny')}
        </Button>
      </div>
      {captions ? (
        <ul className="hc-permission__notes">
          {buttons.allowSession.shown && buttons.allowSession.caption ? (
            <li
              className={`hc-permission__note${buttons.allowSession.warn ? ' hc-permission__note--warn' : ''}`}
              data-testid="permission-session-caption"
            >
              <span className="hc-permission__note-key">{t('perm.allowSession')}</span>
              {buttons.allowSession.caption}
            </li>
          ) : null}
          {buttons.deny.caption ? (
            <li className="hc-permission__note hc-permission__note--warn" data-testid="permission-deny-caption">
              <span className="hc-permission__note-key">{t('perm.deny')}</span>
              {buttons.deny.caption}
            </li>
          ) : null}
        </ul>
      ) : null}
      {buttons.agentOptionNames.length > 0 ? (
        <div className="hc-permission__agent-options" data-testid="permission-agent-options">
          {t('perm.agentOptions')} · {buttons.agentOptionNames.join(' · ')}
        </div>
      ) : null}
    </div>
  );
}
