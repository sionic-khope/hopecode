import type { RefObject } from 'react';
import type { Account, AccountUsage } from '../../../shared/types';
import { formatResetCountdown } from '../../../core/format';
import { effectivePercent } from '../../../core/rotationPolicy';
import { Pill, Popover, type PillTone } from '../common';
import { UsageMeter } from '../StatusLine/UsageMeter';
import './AccountsPopover.css';

export interface AccountsPopoverProps {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  accounts: Account[];
  usageById: Record<string, AccountUsage>;
  /** Active thread's `activeAccountId`; highlights the account "in use". */
  activeAccountId: string | null;
  now: number;
}

interface StatusBadge {
  tone: Extract<PillTone, 'crit' | 'warn' | 'neutral'>;
  label: string;
}

/** Exhausted / overage / auth-stale badge for one account (spec: Usage Statusline popover AC). */
function accountStatusBadge(usage: AccountUsage | undefined, now: number): StatusBadge | null {
  if (!usage) return null;

  if (usage.error === 'auth' || usage.error === 'token_expired') {
    return { tone: 'warn', label: 'Needs re-login' };
  }
  if (usage.error === 'no_credentials') {
    return { tone: 'warn', label: 'Not signed in' };
  }

  const rejected = usage.rejectedUntil;
  if (rejected?.overage && rejected.overage > now) {
    let countdown: string | null = null;
    try {
      countdown = formatResetCountdown(rejected.overage, now);
    } catch {
      countdown = null;
    }
    return { tone: 'crit', label: countdown ? `Overage · ${countdown}` : 'Overage' };
  }
  // Exhausted = 5h/wk blocked by an SDK rejection or polled at 100% (until its reset).
  const blockers = [rejected?.fiveHour, rejected?.sevenDay].filter(
    (v): v is number => typeof v === 'number' && v > now,
  );
  let exhausted = blockers.length > 0;
  for (const reading of [usage.fiveHour, usage.sevenDay]) {
    if (reading && effectivePercent(reading, now) >= 100) {
      exhausted = true;
      if (reading.resetsAt !== null) blockers.push(reading.resetsAt);
    }
  }
  if (exhausted) {
    let countdown: string | null = null;
    try {
      countdown = blockers.length > 0 ? formatResetCountdown(Math.max(...blockers), now) : null;
    } catch {
      countdown = null;
    }
    return { tone: 'crit', label: countdown ? `Exhausted · ${countdown}` : 'Exhausted' };
  }

  if (usage.extraUsageEnabled) {
    return { tone: 'warn', label: 'Extra usage on' };
  }
  if (usage.stale) {
    return { tone: 'neutral', label: 'Stale' };
  }
  return null;
}

/** Statusline popover: per-account alias/color, in-use badge, 5h/wk/fable meters, reset, exhausted/overage/auth state. */
export function AccountsPopover({ open, onClose, anchorRef, accounts, usageById, activeAccountId, now }: AccountsPopoverProps) {
  const ordered = [...accounts].sort((a, b) => a.priority - b.priority);
  const enabledCount = accounts.filter((a) => a.enabled).length;

  return (
    <Popover open={open} onClose={onClose} anchorRef={anchorRef} placement="top-end" width={360} aria-label="Accounts">
      <div className="hc-accounts-pop">
        <div className="hc-accounts-pop__header">
          <span>Accounts</span>
          <span className="hc-accounts-pop__count">
            {enabledCount}/{accounts.length} enabled
          </span>
        </div>
        {ordered.length === 0 ? (
          <div className="hc-accounts-pop__empty">No accounts yet</div>
        ) : (
          <ul className="hc-accounts-pop__list">
            {ordered.map((account) => {
              const usage = usageById[account.id];
              const badge = accountStatusBadge(usage, now);
              const inUse = account.id === activeAccountId;
              return (
                <li
                  key={account.id}
                  className={`hc-accounts-pop__row ${account.enabled ? '' : 'hc-accounts-pop__row--disabled'}`}
                >
                  <div className="hc-accounts-pop__row-top">
                    <span className="hc-accounts-pop__dot" style={{ background: account.color }} aria-hidden />
                    <span className="hc-accounts-pop__alias">{account.alias}</span>
                    {inUse ? (
                      <Pill tone="accent" capsule>
                        In use
                      </Pill>
                    ) : null}
                    {!account.enabled ? <Pill>Disabled</Pill> : null}
                  </div>
                  {account.email || account.plan ? (
                    <div className="hc-accounts-pop__sub">
                      {account.email ?? '–'}
                      {account.plan ? ` · ${account.plan}` : ''}
                    </div>
                  ) : null}
                  <div className="hc-accounts-pop__meters">
                    <UsageMeter
                      label="5h"
                      percent={usage?.fiveHour?.percent ?? null}
                      resetsAt={usage?.fiveHour?.resetsAt}
                      now={now}
                    />
                    <UsageMeter
                      label="wk"
                      percent={usage?.sevenDay?.percent ?? null}
                      resetsAt={usage?.sevenDay?.resetsAt}
                      now={now}
                    />
                    <UsageMeter
                      label="fable"
                      percent={usage?.fable?.percent ?? null}
                      resetsAt={usage?.fable?.resetsAt}
                      now={now}
                    />
                  </div>
                  {badge ? (
                    <Pill tone={badge.tone} className="hc-accounts-pop__badge">
                      {badge.label}
                    </Pill>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Popover>
  );
}
