import { useState, type RefObject } from 'react';
import { Button, Menu, Popover } from '../common';
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
    <Menu
      open={open}
      onClose={onClose}
      anchorRef={anchorRef}
      placement="bottom-end"
      width={196}
      label={label}
      sections={[
        {
          key: 'actions',
          kind: 'action',
          items: actions.map((a) => ({
            key: a.label,
            label: a.label,
            tone: a.destructive ? ('danger' as const) : ('default' as const),
            onSelect: a.onSelect,
          })),
        },
      ]}
    />
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
    <Popover open={open} onClose={close} anchorRef={anchorRef} placement="bottom-start" width={280} aria-label={label}>
      <div className="hc-confirm">
        <p className="hc-confirm__text">{stage === 'force' ? forceMessage : message}</p>
        {error ? (
          <p className="hc-confirm__error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="hc-confirm__actions">
          <Button variant="plain" size="sm" onClick={close}>
            취소
          </Button>
          <Button variant="destructive" size="sm" disabled={busy} onClick={() => run(stage === 'force')}>
            {stage === 'force' ? '강제 삭제' : confirmLabel}
          </Button>
        </div>
      </div>
    </Popover>
  );
}
