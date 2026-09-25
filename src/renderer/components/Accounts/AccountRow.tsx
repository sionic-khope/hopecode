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
    return { tone: 'warn', label: '재로그인 필요' };
  }
  if (usage.extraUsageEnabled) {
    return { tone: 'warn', label: '추가 사용량 켜짐' };
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
          aria-label={`${account.alias} 순서 변경`}
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
            aria-label={`${account.alias} 색상 변경`}
            aria-expanded={colorPickerOpen}
            onClick={() => setColorPickerOpen((v) => !v)}
          />
          {colorPickerOpen ? (
            <div className="hc-acct-row__palette" role="listbox" aria-label="계정 색상">
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
            <button type="button" className="hc-acct-row__alias" onClick={() => setEditingAlias(true)} title="이름 변경">
              {account.alias}
            </button>
          )}
          <span className="hc-acct-row__sub">
            {account.email ?? '로그인 안 됨'}
            {account.plan ? ` · ${account.plan}` : ''}
          </span>
        </div>

        <div className="hc-acct-row__badges">
          {badge ? <Pill tone={badge.tone}>{badge.label}</Pill> : null}
        </div>

        <Switch checked={account.enabled} onChange={(checked) => onUpdate({ enabled: checked })} aria-label={`${account.alias} 활성화`} />

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
              취소
            </Button>
            <Button variant="destructive" size="sm" disabled={removing} onClick={confirmRemove}>
              {removing ? '제거 중…' : '제거'}
            </Button>
          </div>
        ) : (
          <Button
            variant="plain"
            size="sm"
            icon
            aria-label={`${account.alias} 제거`}
            title="계정 제거"
            onClick={() => setConfirmingDelete(true)}
          >
            <TrashIcon />
          </Button>
        )}
      </div>

      {confirmingDelete ? (
        <div className={`hc-acct-row__remove-note${removeError ? ' hc-acct-row__remove-note--error' : ''}`} role={removeError ? 'alert' : undefined}>
          {removeError
            ? `${account.alias} 계정을 제거하지 못했습니다: ${removeError}`
            : `${account.alias} 계정을 제거할까요? 실행 중인 세션은 닫히고 대화 기록은 다른 계정으로 옮겨집니다. 로그인 정보와 설정 폴더는 삭제됩니다.`}
        </div>
      ) : null}

      {showReLoginHint ? (
        <div className="hc-acct-row__hint">
          이 계정으로 <code>claude auth login --claudeai</code>를 실행한 뒤 새로 고치세요.
          {onReLogin ? (
            <Button variant="secondary" size="sm" onClick={onReLogin}>
              다시 로그인
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
