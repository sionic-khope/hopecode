import { useState, type RefObject } from 'react';
import { Button, Popover } from '../common';
import { ipcErrorMessage } from '../../errors';

/** `onConfirm` result asking for a second, forced confirmation (e.g. a worktree with uncommitted changes). */
export const NEEDS_FORCE = 'needs-force';

export interface MenuAction {
  label: string;
  onSelect: () => void;
  destructive?: boolean;
}

/** Small anchored action menu (thread / project context menu). */
export function ActionMenu({
  open,
  onClose,
  anchorRef,
  actions,
  label,
}: {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  actions: readonly MenuAction[];
  label: string;
}) {
  return (
    <Popover open={open} onClose={onClose} anchorRef={anchorRef} placement="bottom-end" width={180} aria-label={label}>
      <div className="hc-menu" role="menu" aria-label={label}>
        {actions.map((a) => (
          <button
            key={a.label}
            type="button"
            role="menuitem"
            className={`hc-menu__item${a.destructive ? ' hc-menu__item--destructive' : ''}`}
            onClick={() => {
              onClose();
              a.onSelect();
            }}
          >
            {a.label}
          </button>
        ))}
      </div>
    </Popover>
  );
}

/**
 * Delete confirmation popover. Calls `onConfirm(false)`; when that resolves NEEDS_FORCE (main refused because a
 * worktree has uncommitted changes) it shows `forceMessage` and retries with `onConfirm(true)`. Errors are
 * shown inline.
 */
export function ConfirmDeletePopover({
  open,
  onClose,
  anchorRef,
  label,
  message,
  forceMessage,
  confirmLabel,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  label: string;
  message: string;
  /** Shown when `onConfirm` resolves NEEDS_FORCE. */
  forceMessage?: string;
  confirmLabel: string;
  onConfirm: (force: boolean) => Promise<typeof NEEDS_FORCE | void>;
}) {
  const [stage, setStage] = useState<'confirm' | 'force'>('confirm');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    setStage('confirm');
    setError(null);
    setBusy(false);
    onClose();
  };

  const run = (force: boolean) => {
    setBusy(true);
    setError(null);
    onConfirm(force)
      .then((result) => {
        if (result === NEEDS_FORCE && !force) {
          setBusy(false);
          setStage('force');
        } else {
          close();
        }
      })
      .catch((err: unknown) => {
        setBusy(false);
        setError(ipcErrorMessage(err));
      });
  };

  return (
    <Popover open={open} onClose={close} anchorRef={anchorRef} placement="bottom-start" width={260} aria-label={label}>
      <div className="hc-confirm">
        <p className="hc-confirm__text">
          {stage === 'force' ? forceMessage : message}
        </p>
        {error ? (
          <p className="hc-confirm__error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="hc-confirm__actions">
          <Button variant="plain" size="sm" onClick={close}>
            Cancel
          </Button>
          <Button variant="destructive" size="sm" disabled={busy} onClick={() => run(stage === 'force')}>
            {stage === 'force' ? 'Force Delete' : confirmLabel}
          </Button>
        </div>
      </div>
    </Popover>
  );
}
