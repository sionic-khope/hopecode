import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { Account } from '../../../shared/types';
import { ACCOUNT_COLORS } from '../../../shared/constants';
import { Button } from '../common';
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

const STATUS_LABEL: Record<LoginStatus, string> = {
  form: 'New account',
  starting: 'Starting login…',
  running: 'Waiting for sign-in…',
  success: 'Signed in',
  error: 'Login failed',
  cancelled: 'Cancelled',
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
      <div className="hc-dialog" role="dialog" aria-modal="true" aria-label="Add account">
        <div className="hc-dialog__header">
          <h2 className="hc-dialog__title">Add Account</h2>
          <span className={`hc-dialog__status hc-dialog__status--${status}`}>{STATUS_LABEL[status]}</span>
        </div>

        {status === 'form' ? (
          <div className="hc-dialog__body">
            <label className="hc-field">
              <span className="hc-field__label">Alias</span>
              <input
                ref={aliasInputRef}
                className="hc-field__input"
                value={alias}
                maxLength={40}
                placeholder="e.g. Work"
                onChange={(e) => onAliasChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && alias.trim()) onStart();
                }}
              />
            </label>
            <div className="hc-field">
              <span className="hc-field__label">Color</span>
              <div className="hc-dialog__palette" role="listbox" aria-label="Account color">
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
              A browser window will open for sign-in. Complete it there, then return to Hopecode.
            </p>
            <pre ref={outputRef} className="hc-dialog__output" aria-label="Login output">
              {output || '…'}
            </pre>
            <label className="hc-field">
              <span className="hc-field__label">Paste code (if prompted)</span>
              <div className="hc-dialog__paste-row">
                <input
                  className="hc-field__input"
                  value={loginInputValue}
                  placeholder="Paste the code from the browser"
                  onChange={(e) => onLoginInputChange(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && loginInputValue.trim()) onSubmitInput();
                  }}
                />
                <Button variant="secondary" size="sm" disabled={!loginInputValue.trim()} onClick={onSubmitInput}>
                  Send
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
              {status === 'cancelled' ? 'Login cancelled.' : (errorMessage ?? 'Login failed.')}
            </div>
          </div>
        ) : null}

        <div className="hc-dialog__actions">
          {status === 'form' ? (
            <>
              <Button variant="plain" size="sm" onClick={onClose}>
                Cancel
              </Button>
              <Button variant="primary" size="sm" disabled={!alias.trim()} onClick={onStart}>
                Start
              </Button>
            </>
          ) : null}
          {inProgress ? (
            <Button variant="destructive" size="sm" onClick={onCancel}>
              Cancel login
            </Button>
          ) : null}
          {status === 'success' ? (
            <Button variant="primary" size="sm" onClick={onClose}>
              Done
            </Button>
          ) : null}
          {(status === 'error' || status === 'cancelled') ? (
            <>
              <Button variant="plain" size="sm" onClick={onClose}>
                Close
              </Button>
              {onRetry ? (
                <Button variant="primary" size="sm" onClick={onRetry}>
                  Try again
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
