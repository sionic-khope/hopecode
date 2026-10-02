import { memo, useRef, useState } from 'react';
import type { Account, PoolSummary } from '../../../shared/types';
import { Menu, type MenuSection } from '../common';
import { GlyphFolderOpen, GlyphPower, GlyphSettings } from '../common/glyphs';
import { IconPlusSmall } from './icons';
import { useLanguage } from '../../i18n';
import { t } from '../../../shared/i18n';

export interface ProfileRowProps {
  /** Account shown in the row: the open thread's account, else the first enabled one by priority. */
  account: Account | null;
  accounts: Account[];
  pool: PoolSummary;
  onOpenDataFolder: () => void;
  onQuit: () => void;
  onAddAccount: () => void;
  /** User-chosen display name (settings.profileName); '' = the account's alias / email. */
  profileName?: string;
  onRenameProfile: () => void;
}

/** `max` -> `Max`, `pro` -> `Pro`; unknown plans are shown as reported. */
export function planLabel(plan: string | null | undefined): string | null {
  if (!plan) return null;
  const p = plan.trim();
  if (!p) return null;
  return p.charAt(0).toUpperCase() + p.slice(1);
}

/**
 * Avatar initials from a name with brackets and symbols stripped: Hangul / other scripts give the first character,
 * Latin gives up to two word initials, uppercased. `name` (the profile name) wins over the alias / email.
 */
export function accountInitials(account: Pick<Account, 'alias' | 'email'>, name = ''): string {
  const source = name.trim() || account.alias.trim() || account.email?.split('@')[0] || '?';
  const words = source.replace(/[^\p{L}\p{N}]+/gu, ' ').split(' ').filter(Boolean);
  const first = words[0];
  if (!first) return '?';
  const lead = [...first][0]!;
  if (!/[A-Za-z]/.test(lead)) return lead;
  return words
    .slice(0, 2)
    .map((w) => [...w][0]!)
    .join('')
    .toUpperCase();
}

export function Avatar({
  account,
  size = 28,
  name,
}: {
  account: Pick<Account, 'alias' | 'email' | 'color'>;
  size?: number;
  name?: string;
}) {
  return (
    <span
      className="hc-avatar"
      aria-hidden
      style={{ width: size, height: size, fontSize: size >= 48 ? 24 : 12, ['--hc-avatar' as string]: account.color }}
    >
      {accountInitials(account, name)}
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
  profileName = '',
  onRenameProfile,
}: ProfileRowProps) {
  useLanguage();
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
            <span className="hc-profile__name">{t('profile.addAccount')}</span>
            <span className="hc-profile__sub">{t('profile.addAccount.sub')}</span>
          </span>
        </button>
      </div>
    );
  }

  const plan = planLabel(account.plan);
  const name = profileName.trim() || account.alias || account.email || t('settings.accounts');
  const poolText = t('profile.pool', { total: pool.total, available: pool.available });

  const sections: MenuSection[] = [
    {
      key: 'account',
      kind: 'action',
      items: [{ key: 'add', label: t('profile.addAccount'), icon: <IconPlusSmall width={16} height={16} />, onSelect: onAddAccount }],
    },
    {
      key: 'rename',
      kind: 'action',
      items: [{ key: 'rename', label: t('profile.rename'), icon: <GlyphSettings />, onSelect: onRenameProfile }],
    },
    {
      key: 'app',
      kind: 'action',
      items: [{ key: 'logs', label: t('profile.openLogs'), icon: <GlyphFolderOpen />, onSelect: onOpenDataFolder }],
    },
    {
      key: 'quit',
      kind: 'action',
      items: [{ key: 'quit', label: t('profile.quit'), icon: <GlyphPower />, meta: '⌘Q', onSelect: onQuit }],
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
        aria-label={t('profile.aria', { name: plan ? `${name} (${plan})` : name })}
        data-testid="profile-row"
        onClick={() => setOpen((v) => !v)}
      >
        <Avatar account={account} name={profileName} />
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
        label={t('profile.label')}
        placement="top-start"
        width={268}
        className="hc-profile-menu"
        header={
          <div className="hc-profile-menu__head">
            <Avatar account={account} size={36} name={profileName} />
            <div className="hc-profile-menu__who">
              <div className="hc-profile-menu__email">{name}</div>
              {account.email && account.email !== name ? <div className="hc-profile-menu__meta">{account.email}</div> : null}
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
