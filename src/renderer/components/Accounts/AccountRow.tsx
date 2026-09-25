import { useEffect, useRef, useState } from 'react';
import { ipcErrorMessage } from '../../errors';
import { useSortable } from '@dnd-kit/sortable';
import type { Account, AccountPatch, AccountUsage, UsageSample } from '../../../shared/types';
import { ACCOUNT_COLORS } from '../../../shared/constants';
import { Button, Pill, Switch, type PillTone } from '../common';
import { UsageChart } from './UsageChart';
import type { ChartRange } from './usageChartScale';
import './AccountsPage.css';

export interface AccountRowProps {
  account: Account;
  usage?: AccountUsage;
  usageHistory: UsageSample[];
  now: number;
  onUpdate: (patch: AccountPatch) => void;
  /** `account:remove`: main closes the account's sessions and moves its transcripts first; rejects on failure. */
  onRemove: () => Promise<void>;
  /** Optional: re-run the login flow for this account's existing configDir (Wave 3 reopens AddAccountDialog). */
  onReLogin?: () => void;
}

interface StatusBadge {
  tone: Extract<PillTone, 'crit' | 'warn'>;
  label: string;
}

function statusBadge(usage: AccountUsage | undefined): StatusBadge | null {
  if (!usage) return null;
  if (usage.error === 'auth' || usage.error === 'token_expired') {
    return { tone: 'warn', label: 'Needs re-login' };
  }
  if (usage.extraUsageEnabled) {
    return { tone: 'warn', label: 'Extra usage on' };
  }
  return null;
}

const needsReLogin = (usage: AccountUsage | undefined) => usage?.error === 'auth' || usage?.error === 'token_expired';

/**
 * One row in AccountsPage: drag handle (dnd-kit priority reorder), color swatch + alias (inline edit),
 * enabled switch, status badges, per-account UsageChart, and a two-step delete confirm.
 * Self-contained sortable item -- AccountsPage only needs to wrap the list in DndContext/SortableContext.
 */
export function AccountRow({ account, usage, usageHistory, now, onUpdate, onRemove, onReLogin }: AccountRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: account.id });
  const [aliasDraft, setAliasDraft] = useState(account.alias);
  const [editingAlias, setEditingAlias] = useState(false);
  const [colorPickerOpen, setColorPickerOpen] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [chartRange, setChartRange] = useState<ChartRange>('24h');
  const aliasInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editingAlias) setAliasDraft(account.alias);
  }, [account.alias, editingAlias]);

  // Inline transform string (no @dnd-kit/utilities dep -- not declared in package.json, which lane 0 owns).
  const style = {
    transform: transform ? `translate3d(${Math.round(transform.x)}px, ${Math.round(transform.y)}px, 0)` : undefined,
    transition: transition ?? undefined,
  };

  const badge = statusBadge(usage);
  const showReLoginHint = needsReLogin(usage);

  const confirmRemove = () => {
    setRemoving(true);
    setRemoveError(null);
    onRemove()
      .catch((err: unknown) => setRemoveError(ipcErrorMessage(err)))
      .finally(() => setRemoving(false));
  };

  const commitAlias = () => {
    const trimmed = aliasDraft.trim();
    setEditingAlias(false);
    if (trimmed && trimmed !== account.alias) onUpdate({ alias: trimmed });
    else setAliasDraft(account.alias);
  };

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={`hc-acct-row ${account.enabled ? '' : 'hc-acct-row--disabled'} ${isDragging ? 'hc-acct-row--dragging' : ''}`}
    >
      <div className="hc-acct-row__main">
        <button
          type="button"
          className="hc-acct-row__handle"
          aria-label={`Reorder ${account.alias}`}
          {...attributes}
          {...listeners}
        >
          <DragHandleIcon />
        </button>

        <div className="hc-acct-row__swatch-wrap">
          <button
            type="button"
            className="hc-acct-row__swatch"
            style={{ background: account.color }}
            aria-label={`Change color for ${account.alias}`}
            aria-expanded={colorPickerOpen}
            onClick={() => setColorPickerOpen((v) => !v)}
          />
          {colorPickerOpen ? (
            <div className="hc-acct-row__palette" role="listbox" aria-label="Account color">
              {ACCOUNT_COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  role="option"
                  aria-selected={color === account.color}
                  className="hc-acct-row__palette-swatch"
                  style={{ background: color }}
                  onClick={() => {
                    onUpdate({ color });
                    setColorPickerOpen(false);
                  }}
                />
              ))}
            </div>
          ) : null}
        </div>

        <div className="hc-acct-row__identity">
          {editingAlias ? (
            <input
              ref={aliasInputRef}
              className="hc-acct-row__alias-input"
              value={aliasDraft}
              maxLength={40}
              autoFocus
              onChange={(e) => setAliasDraft(e.target.value)}
              onBlur={commitAlias}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitAlias();
                if (e.key === 'Escape') {
                  setAliasDraft(account.alias);
                  setEditingAlias(false);
                }
              }}
            />
          ) : (
            <button type="button" className="hc-acct-row__alias" onClick={() => setEditingAlias(true)} title="Rename">
              {account.alias}
            </button>
          )}
          <span className="hc-acct-row__sub">
            {account.email ?? 'Not signed in'}
            {account.plan ? ` · ${account.plan}` : ''}
          </span>
        </div>

        <div className="hc-acct-row__badges">
          {badge ? <Pill tone={badge.tone}>{badge.label}</Pill> : null}
        </div>

        <Switch checked={account.enabled} onChange={(checked) => onUpdate({ enabled: checked })} aria-label={`Enable ${account.alias}`} />

        {confirmingDelete ? (
          <div className="hc-acct-row__confirm">
            <Button
              variant="plain"
              size="sm"
              onClick={() => {
                setConfirmingDelete(false);
                setRemoveError(null);
              }}
            >
              Cancel
            </Button>
            <Button variant="destructive" size="sm" disabled={removing} onClick={confirmRemove}>
              {removing ? 'Removing…' : 'Remove'}
            </Button>
          </div>
        ) : (
          <Button
            variant="plain"
            size="sm"
            icon
            aria-label={`Remove ${account.alias}`}
            title="Remove account"
            onClick={() => setConfirmingDelete(true)}
          >
            <TrashIcon />
          </Button>
        )}
      </div>

      {confirmingDelete ? (
        <div className={`hc-acct-row__remove-note${removeError ? ' hc-acct-row__remove-note--error' : ''}`} role={removeError ? 'alert' : undefined}>
          {removeError
            ? `Could not remove ${account.alias}: ${removeError}`
            : `Remove ${account.alias}? Its running sessions are closed and its conversations move to another account. The account's sign-in and config folder are deleted.`}
        </div>
      ) : null}

      {showReLoginHint ? (
        <div className="hc-acct-row__hint">
          Run <code>claude auth login --claudeai</code> for this account, then refresh.
          {onReLogin ? (
            <Button variant="secondary" size="sm" onClick={onReLogin}>
              Re-login
            </Button>
          ) : null}
        </div>
      ) : null}

      <UsageChart samples={usageHistory} range={chartRange} onRangeChange={setChartRange} now={now} />
    </li>
  );
}

function DragHandleIcon() {
  return (
    <svg width={12} height={14} viewBox="0 0 12 14" fill="currentColor" aria-hidden>
      <circle cx="3" cy="2.5" r="1.3" />
      <circle cx="9" cy="2.5" r="1.3" />
      <circle cx="3" cy="7" r="1.3" />
      <circle cx="9" cy="7" r="1.3" />
      <circle cx="3" cy="11.5" r="1.3" />
      <circle cx="9" cy="11.5" r="1.3" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width={13} height={13} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3.5 4.5h9M6.3 4.5V3a1 1 0 0 1 1-1h1.4a1 1 0 0 1 1 1v1.5M6 7.3v4M10 7.3v4M4.3 4.5l.6 8a1 1 0 0 0 1 .9h4.2a1 1 0 0 0 1-.9l.6-8" />
    </svg>
  );
}
