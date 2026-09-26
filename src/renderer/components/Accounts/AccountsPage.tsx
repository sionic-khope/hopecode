import { useEffect, useMemo, useRef } from 'react';
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, arrayMove, sortableKeyboardCoordinates, verticalListSortingStrategy } from '@dnd-kit/sortable';
import type { Account, AccountPatch, AccountUsage, UsageSample } from '../../../shared/types';
import { Button } from '../common';
import { AccountRow } from './AccountRow';
import './AccountsPage.css';

export interface AccountsPageProps {
  accounts: Account[];
  usageById: Record<string, AccountUsage>;
  /** Per-account usage samples for the trend chart (`usage:history`). Missing entries render an empty chart. */
  usageHistoryByAccount: Record<string, UsageSample[]>;
  now: number;
  /** `account:reorder` -- full ordered id list after a drag. */
  onReorder: (orderedIds: string[]) => void;
  /** `account:update` for one account (alias/color/enabled). */
  onUpdateAccount: (accountId: string, patch: AccountPatch) => void;
  /** `account:remove` for one account; rejects with main's error (shown in the row). */
  onRemoveAccount: (accountId: string) => Promise<void>;
  /** Opens AddAccountDialog (owned by the store; the dialog itself is a sibling component). */
  onAddAccount: () => void;
  /** Optional: return to the previous route (e.g. the last selected thread). */
  onBack?: () => void;
  /** Re-run login for an existing account (re-auth flow). Passed through to each AccountRow. */
  onReLoginAccount?: (accountId: string) => void;
  /** Opened from "사용량": scroll the first usage chart into view (and flash the charts once). */
  focusUsage?: boolean;
  onFocused?: () => void;
}

/**
 * Full accounts management page: priority-ordered, drag-reorderable list of AccountRow, each with its own
 * UsageChart. Pure props/callbacks -- the store wires this to IPC in Wave 3 (plan 8, lane 2B).
 */
export function AccountsPage({
  accounts,
  usageById,
  usageHistoryByAccount,
  now,
  onReorder,
  onUpdateAccount,
  onRemoveAccount,
  onAddAccount,
  onBack,
  onReLoginAccount,
  focusUsage = false,
  onFocused,
}: AccountsPageProps) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!focusUsage) return;
    const id = requestAnimationFrame(() => {
      const root = rootRef.current;
      const chart = root?.querySelector<HTMLElement>('.hc-chart');
      if (chart) {
        const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        chart.scrollIntoView({ block: 'center', behavior: smooth ? 'smooth' : 'auto' });
        root?.classList.add('hc-accounts-page--usage-focus');
      }
      onFocused?.();
    });
    return () => cancelAnimationFrame(id);
  }, [focusUsage, onFocused]);

  const ordered = useMemo(() => [...accounts].sort((a, b) => a.priority - b.priority), [accounts]);
  const orderedIds = useMemo(() => ordered.map((a) => a.id), [ordered]);

  // Pointer drag, plus keyboard reorder on the focused handle (Space to lift, ↑/↓ to move, Space to drop).
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = orderedIds.indexOf(String(active.id));
    const newIndex = orderedIds.indexOf(String(over.id));
    if (oldIndex === -1 || newIndex === -1) return;
    onReorder(arrayMove(orderedIds, oldIndex, newIndex));
  };

  const enabledCount = accounts.filter((a) => a.enabled).length;

  return (
    <div className="hc-accounts-page" ref={rootRef}>
      <div className="hc-accounts-page__header">
        <div className="hc-accounts-page__title-row">
          {onBack ? (
            <Button variant="plain" size="sm" icon aria-label="뒤로" onClick={onBack}>
              <BackIcon />
            </Button>
          ) : null}
          <h1 className="hc-accounts-page__title">계정</h1>
          <span className="hc-accounts-page__count">
            {enabledCount}/{accounts.length} 활성
          </span>
        </div>
        <Button variant="primary" size="sm" onClick={onAddAccount}>
          + 계정 추가
        </Button>
      </div>

      {ordered.length === 0 ? (
        <div className="hc-accounts-page__empty">
          <p>아직 계정이 없습니다</p>
          <p className="hc-accounts-page__empty-sub">Claude 구독 계정을 추가해 세션 풀을 시작하세요.</p>
          <Button variant="primary" size="sm" onClick={onAddAccount}>
            + 계정 추가
          </Button>
        </div>
      ) : (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={orderedIds} strategy={verticalListSortingStrategy}>
            <ul className="hc-accounts-page__list">
              {ordered.map((account) => (
                <AccountRow
                  key={account.id}
                  account={account}
                  usage={usageById[account.id]}
                  usageHistory={usageHistoryByAccount[account.id] ?? []}
                  now={now}
                  onUpdate={(patch) => onUpdateAccount(account.id, patch)}
                  onRemove={() => onRemoveAccount(account.id)}
                  onReLogin={onReLoginAccount ? () => onReLoginAccount(account.id) : undefined}
                />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      )}
    </div>
  );
}

function BackIcon() {
  return (
    <svg width={13} height={13} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M10 3.5 5 8l5 4.5" />
    </svg>
  );
}
