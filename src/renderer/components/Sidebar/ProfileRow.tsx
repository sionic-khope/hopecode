import { memo, useRef, useState } from 'react';
import type { Account, PoolSummary } from '../../../shared/types';
import { Menu, type MenuSection } from '../common';
import { GlyphFolderOpen, GlyphPower } from '../common/glyphs';
import { IconPlusSmall } from './icons';

export interface ProfileRowProps {
  /** Account shown in the row: the open thread's account, else the first enabled one by priority. */
  account: Account | null;
  accounts: Account[];
  pool: PoolSummary;
  onOpenDataFolder: () => void;
  onQuit: () => void;
  onAddAccount: () => void;
}

/** `max` -> `Max`, `pro` -> `Pro`; unknown plans are shown as reported. */
export function planLabel(plan: string | null | undefined): string | null {
  if (!plan) return null;
  const p = plan.trim();
  if (!p) return null;
  return p.charAt(0).toUpperCase() + p.slice(1);
}

/** Up to two initials from the alias (or the email's local part). */
export function accountInitials(account: Pick<Account, 'alias' | 'email'>): string {
  const source = account.alias.trim() || account.email?.split('@')[0] || '?';
  const words = source.split(/[\s._-]+/).filter(Boolean);
  const letters = words.length >= 2 ? `${[...words[0]!][0]}${[...words[1]!][0]}` : [...source].slice(0, 2).join('');
  return letters.toUpperCase();
}

export function Avatar({ account, size = 28 }: { account: Pick<Account, 'alias' | 'email' | 'color'>; size?: number }) {
  return (
    <span
      className="hc-avatar"
      aria-hidden
      style={{ width: size, height: size, fontSize: Math.round(size * 0.4), ['--hc-avatar' as string]: account.color }}
    >
      {accountInitials(account)}
    </span>
  );
}

/**
 * Sidebar footer (Codex / ChatGPT style): avatar, account name, plan. Opens an upward menu with the account
 * summary, 계정 추가, the log folder and quit (pages such as 계정 / 설정 live in the nav's 더보기 menu). With no
 * account at all the row becomes "계정 추가".
 */
export const ProfileRow = memo(function ProfileRow({
  account,
  accounts,
  pool,
  onOpenDataFolder,
  onQuit,
  onAddAccount,
}: ProfileRowProps) {
  const [open, setOpen] = useState(false);
  const rowRef = useRef<HTMLButtonElement>(null);

  if (accounts.length === 0 || !account) {
    return (
      <div className="hc-profile">
        <button type="button" className="hc-profile__row hc-profile__row--add" onClick={onAddAccount}>
          <span className="hc-profile__add-icon" aria-hidden>
            <IconPlusSmall width={14} height={14} />
          </span>
          <span className="hc-profile__text">
            <span className="hc-profile__name">계정 추가</span>
            <span className="hc-profile__sub">Claude 구독 계정으로 시작하세요</span>
          </span>
        </button>
      </div>
    );
  }

  const plan = planLabel(account.plan);
  const name = account.alias || account.email || '계정';
  const poolText = `계정 ${pool.total}개 · ${pool.available}개 사용 가능`;

  const sections: MenuSection[] = [
    {
      key: 'account',
      kind: 'action',
      items: [{ key: 'add', label: '계정 추가', icon: <IconPlusSmall width={16} height={16} />, onSelect: onAddAccount }],
    },
    {
      key: 'app',
      kind: 'action',
      items: [{ key: 'logs', label: '로그 폴더 열기', icon: <GlyphFolderOpen />, onSelect: onOpenDataFolder }],
    },
    {
      key: 'quit',
      kind: 'action',
      items: [{ key: 'quit', label: 'Hopecode 종료', icon: <GlyphPower />, meta: '⌘Q', onSelect: onQuit }],
    },
  ];

  return (
    <div className="hc-profile">
      <button
        ref={rowRef}
        type="button"
        className={`hc-profile__row${open ? ' hc-profile__row--open' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`프로필: ${name}${plan ? ` (${plan})` : ''}`}
        data-testid="profile-row"
        onClick={() => setOpen((v) => !v)}
      >
        <Avatar account={account} />
        <span className="hc-profile__text">
          <span className="hc-profile__name">{name}</span>
          <span className="hc-profile__sub">{account.email && account.email !== name ? account.email : poolText}</span>
        </span>
        {plan ? <span className="hc-profile__plan">{plan}</span> : null}
      </button>
      <Menu
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={rowRef}
        sections={sections}
        label="프로필"
        placement="top-start"
        width={268}
        className="hc-profile-menu"
        header={
          <div className="hc-profile-menu__head">
            <Avatar account={account} size={36} />
            <div className="hc-profile-menu__who">
              <div className="hc-profile-menu__email">{account.email ?? name}</div>
              <div className="hc-profile-menu__meta">
                {plan ? <span className="hc-profile__plan">{plan}</span> : null}
                <span>{poolText}</span>
              </div>
            </div>
          </div>
        }
      />
    </div>
  );
});
