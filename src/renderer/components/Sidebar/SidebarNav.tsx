import { memo, useRef, useState, type ReactNode } from 'react';
import type { Account } from '../../../shared/types';
import { Menu, type MenuSection } from '../common';
import { GlyphChart, GlyphInfo, GlyphKeyboard, GlyphPeople, GlyphSettings } from '../common/glyphs';
import { IconArchive, IconClock, IconCompose, IconDots, IconPlug, IconPlusCircle, IconPullRequest, IconSearch } from './icons';
import './SidebarNav.css';

/** Main-area page the nav highlights. */
export type NavPage = 'draft' | 'prs' | 'schedule' | 'plugins' | 'accounts' | 'settings' | null;

export interface SidebarNavProps {
  active: NavPage;
  accounts: Account[];
  archivedCount: number;
  onNewChat: () => void;
  onSearch: () => void;
  onOpenPrs: () => void;
  onOpenSchedule: () => void;
  onOpenPlugins: () => void;
  onOpenAccounts: () => void;
  onOpenUsage: () => void;
  onOpenSettings: () => void;
  onShowShortcuts: () => void;
  onShowAbout: () => void;
  onShowArchived: () => void;
}

/**
 * Codex-style nav: 새 채팅 (⌘N) · 검색 (⌘K, opens the palette on thread search) · 풀 리퀘스트 · 예약 · 플러그인,
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
  onOpenAccounts,
  onOpenUsage,
  onOpenSettings,
  onShowShortcuts,
  onShowAbout,
  onShowArchived,
}: SidebarNavProps) {
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
        { key: 'accounts', label: '계정', icon: <GlyphPeople />, meta: `${enabled}/${accounts.length}`, onSelect: onOpenAccounts },
        { key: 'usage', label: '사용량', icon: <GlyphChart />, onSelect: onOpenUsage },
        { key: 'settings', label: '설정', icon: <GlyphSettings />, meta: '⌘,', onSelect: onOpenSettings },
      ],
    },
    {
      key: 'help',
      kind: 'action',
      items: [
        { key: 'shortcuts', label: '키보드 단축키', icon: <GlyphKeyboard />, onSelect: onShowShortcuts },
        { key: 'about', label: '앱 정보', icon: <GlyphInfo />, onSelect: onShowAbout },
      ],
    },
    ...(archivedCount > 0
      ? [
          {
            key: 'archive',
            kind: 'action' as const,
            items: [{ key: 'archived', label: '보관된 스레드', icon: <IconArchive width={15} height={15} />, meta: String(archivedCount), onSelect: onShowArchived }],
          },
        ]
      : []),
  ];

  return (
    <nav className="hc-sidebar__nav" aria-label="탐색" data-testid="sidebar-nav">
      <button
        type="button"
        className={`hc-nav hc-nav--compose${active === 'draft' ? ' hc-nav--active' : ''}`}
        aria-current={active === 'draft' ? 'page' : undefined}
        aria-keyshortcuts="Meta+N"
        onClick={onNewChat}
      >
        <IconCompose />
        <span className="hc-nav__label">새 채팅</span>
        <kbd className="hc-nav__kbd">⌘N</kbd>
        <span className="hc-nav__plus" aria-hidden>
          <IconPlusCircle />
        </span>
      </button>
      <button type="button" className="hc-nav" aria-keyshortcuts="Meta+K" onClick={onSearch}>
        <IconSearch />
        <span className="hc-nav__label">검색</span>
        <kbd className="hc-nav__kbd hc-nav__kbd--always">⌘K</kbd>
      </button>
      {page('prs', '풀 리퀘스트', <IconPullRequest />, onOpenPrs)}
      {page('schedule', '예약', <IconClock />, onOpenSchedule)}
      {page('plugins', '플러그인', <IconPlug />, onOpenPlugins)}
      <button
        ref={moreRef}
        type="button"
        className={`hc-nav${active === 'accounts' || active === 'settings' ? ' hc-nav--active' : ''}${moreOpen ? ' hc-nav--open' : ''}`}
        aria-haspopup="menu"
        aria-expanded={moreOpen}
        onClick={() => setMoreOpen((v) => !v)}
      >
        <IconDots />
        <span className="hc-nav__label">더보기</span>
      </button>
      <Menu
        open={moreOpen}
        onClose={() => setMoreOpen(false)}
        anchorRef={moreRef}
        sections={sections}
        label="탐색 더보기"
        placement="bottom-start"
        width={248}
      />
    </nav>
  );
});
