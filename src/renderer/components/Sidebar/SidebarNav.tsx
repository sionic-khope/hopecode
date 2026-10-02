import { memo, useRef, useState, type ReactNode } from 'react';
import type { Account } from '../../../shared/types';
import { Menu, type MenuSection } from '../common';
import { GlyphChart, GlyphInfo, GlyphKeyboard, GlyphPeople, GlyphSettings } from '../common/glyphs';
import { IconArchive, IconClock, IconCompose, IconDots, IconNote, IconPlug, IconPlusCircle, IconPullRequest, IconSearch } from './icons';
import { useLanguage } from '../../i18n';
import { t } from '../../../shared/i18n';
import './SidebarNav.css';

/** Main-area page the nav highlights. */
export type NavPage = 'draft' | 'prs' | 'schedule' | 'plugins' | 'notes' | 'accounts' | 'settings' | null;

export interface SidebarNavProps {
  active: NavPage;
  accounts: Account[];
  archivedCount: number;
  onNewChat: () => void;
  onSearch: () => void;
  onOpenPrs: () => void;
  onOpenSchedule: () => void;
  onOpenPlugins: () => void;
  onOpenNotes: () => void;
  onOpenAccounts: () => void;
  onOpenUsage: () => void;
  onOpenSettings: () => void;
  onShowShortcuts: () => void;
  onShowAbout: () => void;
  onShowArchived: () => void;
}

/**
 * Codex-style nav: 새 채팅 (⌘N) · 검색 (⌘K, opens the palette on thread search) · 풀 리퀘스트 · 예약 · 플러그인 · 노트,
 * then a collapsed 더보기 menu for the less frequent pages (계정, 사용량, 설정, 단축키, 앱 정보, 보관된 스레드).
 */
export const SidebarNav = memo(function SidebarNav({
  active,
  accounts,
  archivedCount,
  onNewChat,
  onSearch,
  onOpenPrs,
  onOpenSchedule,
  onOpenPlugins,
  onOpenNotes,
  onOpenAccounts,
  onOpenUsage,
  onOpenSettings,
  onShowShortcuts,
  onShowAbout,
  onShowArchived,
}: SidebarNavProps) {
  useLanguage();
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  const enabled = accounts.filter((a) => a.enabled).length;

  const page = (key: Exclude<NavPage, null>, label: string, icon: ReactNode, onClick: () => void) => (
    <button
      type="button"
      className={`hc-nav${active === key ? ' hc-nav--active' : ''}`}
      aria-current={active === key ? 'page' : undefined}
      onClick={onClick}
    >
      {icon}
      <span className="hc-nav__label">{label}</span>
    </button>
  );

  const sections: MenuSection[] = [
    {
      key: 'pages',
      kind: 'action',
      items: [
        { key: 'accounts', label: t('settings.accounts'), icon: <GlyphPeople />, meta: `${enabled}/${accounts.length}`, onSelect: onOpenAccounts },
        { key: 'usage', label: t('nav.usage'), icon: <GlyphChart />, onSelect: onOpenUsage },
        { key: 'settings', label: t('settings.title'), icon: <GlyphSettings />, meta: '⌘,', onSelect: onOpenSettings },
      ],
    },
    {
      key: 'help',
      kind: 'action',
      items: [
        { key: 'shortcuts', label: t('nav.shortcuts'), icon: <GlyphKeyboard />, onSelect: onShowShortcuts },
        { key: 'about', label: t('nav.about'), icon: <GlyphInfo />, onSelect: onShowAbout },
      ],
    },
    ...(archivedCount > 0
      ? [
          {
            key: 'archive',
            kind: 'action' as const,
            items: [{ key: 'archived', label: t('settings.archived'), icon: <IconArchive width={15} height={15} />, meta: String(archivedCount), onSelect: onShowArchived }],
          },
        ]
      : []),
  ];

  return (
    <nav className="hc-sidebar__nav" aria-label={t('nav.aria')} data-testid="sidebar-nav">
      <button
        type="button"
        className={`hc-nav hc-nav--compose${active === 'draft' ? ' hc-nav--active' : ''}`}
        aria-current={active === 'draft' ? 'page' : undefined}
        aria-keyshortcuts="Meta+N"
        onClick={onNewChat}
      >
        <IconCompose />
        <span className="hc-nav__label">{t('menu.newChat')}</span>
        <kbd className="hc-nav__kbd">⌘N</kbd>
        <span className="hc-nav__plus" aria-hidden>
          <IconPlusCircle />
        </span>
      </button>
      <button type="button" className="hc-nav" aria-keyshortcuts="Meta+K" onClick={onSearch}>
        <IconSearch />
        <span className="hc-nav__label">{t('nav.search')}</span>
        <kbd className="hc-nav__kbd hc-nav__kbd--always">⌘K</kbd>
      </button>
      {page('prs', t('nav.prs'), <IconPullRequest />, onOpenPrs)}
      {page('schedule', t('nav.schedule'), <IconClock />, onOpenSchedule)}
      {page('plugins', t('nav.plugins'), <IconPlug />, onOpenPlugins)}
      {page('notes', t('nav.notes'), <IconNote />, onOpenNotes)}
      <button
        ref={moreRef}
        type="button"
        className={`hc-nav${active === 'accounts' || active === 'settings' ? ' hc-nav--active' : ''}${moreOpen ? ' hc-nav--open' : ''}`}
        aria-haspopup="menu"
        aria-expanded={moreOpen}
        onClick={() => setMoreOpen((v) => !v)}
      >
        <IconDots />
        <span className="hc-nav__label">{t('common.more')}</span>
      </button>
      <Menu
        open={moreOpen}
        onClose={() => setMoreOpen(false)}
        anchorRef={moreRef}
        sections={sections}
        label={t('nav.moreAria')}
        placement="bottom-start"
        width={248}
      />
    </nav>
  );
});
