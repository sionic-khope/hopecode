import { memo, useRef, useState } from 'react';
import type { Account, ModelOption, UiPermissionMode } from '../../../shared/types';
import { UI_PERMISSION_MODES } from '../../../shared/constants';
import { Popover, Segmented, type SegmentedOption } from '../common';
import { modelLabel } from '../../../core/modelLabel';
import { ChevronIcon, PinIcon } from './icons';
import './Chat.css';

export interface ThreadToolbarProps {
  models: ModelOption[];
  model: string;
  onModelChange: (value: string) => void;
  permissionMode: UiPermissionMode;
  onPermissionModeChange: (mode: UiPermissionMode) => void;
  accounts: Account[];
  pinnedAccountId: string | null;
  onPinAccountChange: (accountId: string | null) => void;
  /** Account currently running (or last used) for this thread; shown as a badge in the pin picker. */
  activeAccountId?: string | null;
}

const PERMISSION_MODE_LABEL: Record<UiPermissionMode, string> = {
  default: 'Default',
  plan: 'Plan',
  acceptEdits: 'Accept Edits',
  bypassPermissions: 'Bypass',
};

const PERMISSION_MODE_TITLE: Record<UiPermissionMode, string> = {
  default: 'Ask before tools that change files or run commands',
  plan: 'Plan only: no edits or commands',
  acceptEdits: 'Apply file edits without asking',
  bypassPermissions: 'Bypass: every tool runs without asking (confirmation required)',
};

const PERMISSION_MODE_OPTIONS: readonly SegmentedOption<UiPermissionMode>[] = UI_PERMISSION_MODES.map((mode) => ({
  value: mode,
  label: PERMISSION_MODE_LABEL[mode],
  title: PERMISSION_MODE_TITLE[mode],
  className: mode === 'bypassPermissions' ? 'hc-seg__item--danger' : undefined,
}));

/** Model / permission-mode / account-pin controls for the active thread (plan 4.4). */
export const ThreadToolbar = memo(function ThreadToolbar({
  models,
  model,
  onModelChange,
  permissionMode,
  onPermissionModeChange,
  accounts,
  pinnedAccountId,
  onPinAccountChange,
  activeAccountId = null,
}: ThreadToolbarProps) {
  return (
    <div className="hc-toolbar no-drag">
      <div className="hc-toolbar__group">
        <ModelPicker models={models} value={model} onChange={onModelChange} />
      </div>
      <div className="hc-toolbar__spacer" />
      <div className="hc-toolbar__group">
        <Segmented
          aria-label="Permission mode"
          size="sm"
          options={PERMISSION_MODE_OPTIONS}
          value={permissionMode}
          onChange={onPermissionModeChange}
        />
        <AccountPinPicker
          accounts={accounts}
          pinnedAccountId={pinnedAccountId}
          activeAccountId={activeAccountId}
          onChange={onPinAccountChange}
        />
      </div>
    </div>
  );
});

function ModelPicker({
  models,
  value,
  onChange,
}: {
  models: ModelOption[];
  value: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const current = models.find((m) => m.value === value);

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className="hc-picker"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span>{current?.label ?? modelLabel(value, models)}</span>
        <ChevronIcon className="hc-picker__chevron" width={11} height={11} />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={anchorRef} width={220} aria-label="Model">
        <div className="hc-picker-list" role="listbox">
          {models.map((m) => (
            <button
              key={m.value}
              type="button"
              role="option"
              aria-selected={m.value === value}
              className="hc-picker-list__item"
              onClick={() => {
                onChange(m.value);
                setOpen(false);
              }}
            >
              <span className="hc-picker-list__label">
                <span>{m.label}</span>
                {m.description ? <span className="hc-picker-list__desc">{m.description}</span> : null}
              </span>
            </button>
          ))}
        </div>
      </Popover>
    </>
  );
}

function AccountPinPicker({
  accounts,
  pinnedAccountId,
  activeAccountId,
  onChange,
}: {
  accounts: Account[];
  pinnedAccountId: string | null;
  activeAccountId: string | null;
  onChange: (accountId: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const pinned = accounts.find((a) => a.id === pinnedAccountId) ?? null;

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className="hc-picker"
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Account pin"
        onClick={() => setOpen((v) => !v)}
      >
        <PinIcon width={11} height={11} />
        {pinned ? (
          <>
            <span className="hc-picker__dot" style={{ background: pinned.color }} aria-hidden />
            <span>{pinned.alias}</span>
          </>
        ) : (
          <span>Auto</span>
        )}
        <ChevronIcon className="hc-picker__chevron" width={11} height={11} />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={anchorRef} placement="bottom-end" width={240} aria-label="Pin account">
        <div className="hc-picker-list" role="listbox">
          <button
            type="button"
            role="option"
            aria-selected={pinnedAccountId === null}
            className="hc-picker-list__item"
            onClick={() => {
              onChange(null);
              setOpen(false);
            }}
          >
            <span className="hc-picker-list__label">
              <span>Auto</span>
              <span className="hc-picker-list__desc">Highest-priority available account</span>
            </span>
          </button>
          {accounts.map((a) => (
            <button
              key={a.id}
              type="button"
              role="option"
              aria-selected={a.id === pinnedAccountId}
              disabled={!a.enabled}
              className="hc-picker-list__item"
              onClick={() => {
                onChange(a.id);
                setOpen(false);
              }}
            >
              <span className="hc-picker__dot" style={{ background: a.color }} aria-hidden />
              <span className="hc-picker-list__label">
                <span>{a.alias}</span>
              </span>
              {a.id === activeAccountId ? <span className="hc-picker-list__meta">Active</span> : null}
            </button>
          ))}
        </div>
      </Popover>
    </>
  );
}
