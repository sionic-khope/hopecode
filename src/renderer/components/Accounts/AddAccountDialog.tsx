import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { Account } from '../../../shared/types';
import { ACCOUNT_COLORS } from '../../../shared/constants';
import { Button } from '../common';
import { t, type MessageKey } from '../../../shared/i18n';
import './AccountsPage.css';

export type LoginStatus = 'form' | 'starting' | 'running' | 'success' | 'error' | 'cancelled';

export interface AddAccountDialogProps {
  open: boolean;
  status: LoginStatus;
  alias: string;
  onAliasChange: (alias: string) => void;
  color: string;
  onColorChange: (color: string) => void;
  /** `account:loginStart` */
  onStart: () => void;
  /** Streamed `login:data` output, joined (rendered as a read-only summary log, not a full xterm). */
  output: string;
  /** Value of the paste-code field, sent via `account:loginInput`. */
  loginInputValue: string;
  onLoginInputChange: (value: string) => void;
  onSubmitInput: () => void;
  /** `account:loginCancel` */
  onCancel: () => void;
  onClose: () => void;
  onRetry?: () => void;
  /** Filled once `login:exit` reports success. */
  account?: Account | null;
  errorMessage?: string | null;
}

const STATUS_LABEL: Record<LoginStatus, MessageKey> = {
  form: 'login.status.form',
  starting: 'login.status.starting',
  running: 'login.status.running',
  success: 'localAuth.loggedIn',
  error: 'login.status.error',
  cancelled: 'login.status.cancelled',
};

/**
 * Add-account flow (spec: alias/color -> Start -> login progress -> paste-code input -> Cancel -> done/fail).
 * Renders the pty output as a read-only text summary rather than embedding a second xterm instance --
 * TerminalPane's per-thread registry is a separate concern and this is a one-shot, throwaway login log.
 */
export function AddAccountDialog({
  open,
  status,
  alias,
  onAliasChange,
  color,
  onColorChange,
  onStart,
  output,
  loginInputValue,
  onLoginInputChange,
  onSubmitInput,
  onCancel,
  onClose,
  onRetry,
  account,
  errorMessage,
}: AddAccountDialogProps) {
  const outputRef = useRef<HTMLPreElement>(null);
  const aliasInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open && status === 'form') aliasInputRef.current?.focus();
  }, [open, status]);

  useEffect(() => {
    const el = outputRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [output]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && (status === 'form' || status === 'success' || status === 'error' || status === 'cancelled')) {
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, status, onClose]);

  if (!open) return null;

  const inProgress = status === 'starting' || status === 'running';
  const canDismiss = !inProgress;

  return createPortal(
    <div className="hc-dialog-overlay" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && canDismiss && onClose()}>
      <div className="hc-dialog" role="dialog" aria-modal="true" aria-label={t('profile.addAccount')}>
        <div className="hc-dialog__header">
          <h2 className="hc-dialog__title">{t('profile.addAccount')}</h2>
          <span className={`hc-dialog__status hc-dialog__status--${status}`}>{t(STATUS_LABEL[status])}</span>
        </div>

        {status === 'form' ? (
          <div className="hc-dialog__body">
            <label className="hc-field">
              <span className="hc-field__label">{t('login.alias')}</span>
              <input
                ref={aliasInputRef}
                className="hc-field__input"
                value={alias}
                maxLength={40}
                placeholder={t('login.alias.placeholder')}
                onChange={(e) => onAliasChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && alias.trim()) onStart();
                }}
              />
            </label>
            <div className="hc-field">
              <span className="hc-field__label">{t('login.color')}</span>
              <div className="hc-dialog__palette" role="listbox" aria-label={t('acct.colorList')}>
                {ACCOUNT_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    role="option"
                    aria-selected={c === color}
                    className={`hc-dialog__palette-swatch ${c === color ? 'hc-dialog__palette-swatch--selected' : ''}`}
                    style={{ background: c }}
                    onClick={() => onColorChange(c)}
                  />
                ))}
              </div>
            </div>
          </div>
        ) : null}

        {inProgress ? (
          <div className="hc-dialog__body">
            <p className="hc-dialog__notice">
              {t('login.browserNote')}
            </p>
            <pre ref={outputRef} className="hc-dialog__output" aria-label={t('login.output')}>
              {output || '…'}
            </pre>
            <label className="hc-field">
              <span className="hc-field__label">{t('login.paste')}</span>
              <div className="hc-dialog__paste-row">
                <input
                  className="hc-field__input"
                  value={loginInputValue}
                  placeholder={t('login.paste.placeholder')}
                  onChange={(e) => onLoginInputChange(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && loginInputValue.trim()) onSubmitInput();
                  }}
                />
                <Button variant="secondary" size="sm" disabled={!loginInputValue.trim()} onClick={onSubmitInput}>
                  {t('composer.send')}
                </Button>
              </div>
            </label>
          </div>
        ) : null}

        {status === 'success' ? (
          <div className="hc-dialog__body">
            <div className="hc-dialog__result hc-dialog__result--ok">
              <span className="hc-dialog__swatch" style={{ background: account?.color ?? color }} aria-hidden />
              <div>
                <div className="hc-dialog__result-alias">{account?.alias ?? alias}</div>
                <div className="hc-dialog__result-sub">
                  {account?.email ?? '–'}
                  {account?.plan ? ` · ${account.plan}` : ''}
                </div>
              </div>
            </div>
          </div>
        ) : null}

        {status === 'error' || status === 'cancelled' ? (
          <div className="hc-dialog__body">
            <div className="hc-dialog__result hc-dialog__result--error">
              {status === 'cancelled' ? t('login.cancelled') : (errorMessage ?? t('login.failed'))}
            </div>
          </div>
        ) : null}

        <div className="hc-dialog__actions">
          {status === 'form' ? (
            <>
              <Button variant="plain" size="sm" onClick={onClose}>
                {t('common.cancel')}
              </Button>
              <Button variant="primary" size="sm" disabled={!alias.trim()} onClick={onStart}>
                {t('login.start')}
              </Button>
            </>
          ) : null}
          {inProgress ? (
            <Button variant="destructive" size="sm" onClick={onCancel}>
              {t('login.cancel')}
            </Button>
          ) : null}
          {status === 'success' ? (
            <Button variant="primary" size="sm" onClick={onClose}>
              {t('login.done')}
            </Button>
          ) : null}
          {(status === 'error' || status === 'cancelled') ? (
            <>
              <Button variant="plain" size="sm" onClick={onClose}>
                {t('common.close')}
              </Button>
              {onRetry ? (
                <Button variant="primary" size="sm" onClick={onRetry}>
                  {t('common.retry')}
                </Button>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}
