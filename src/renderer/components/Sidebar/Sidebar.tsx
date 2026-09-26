import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Account, Project, Thread } from '../../../shared/types';
import { BrandMark } from '../common';
import { GlyphSettings } from '../common/glyphs';
import { IconArchive, IconChevron, IconClose, IconCompose, IconFolderPlus, IconPeople, IconPinThread, IconSearch } from './icons';
import { ProjectGroup, type ThreadRowHandlers } from './ProjectGroup';
import { MINUTE_MS } from '../../../shared/constants';
import { ThreadRow } from './ThreadRow';
import './Sidebar.css';

export interface SidebarProps extends ThreadRowHandlers {
  projects: Project[];
  threads: Thread[];
  accounts: Account[];
  selectedThreadId: string | null;
  /** The draft (new chat) screen is showing. */
  draftActive: boolean;
  /** The Accounts route is showing. */
  accountsActive: boolean;
  /** The Settings route is showing. */
  settingsActive: boolean;
  /** Threads with a finished turn not yet opened ("완료" pill). */
  unseenDone: Readonly<Record<string, true>>;
  /** Footer (profile row). */
  footer?: ReactNode;
  onNewChat: () => void;
  onNewChatIn: (projectId: string) => void;
  onOpenAccounts: () => void;
  onOpenSettings: () => void;
  onAddProject: () => void;
  onRemoveProject: (projectId: string) => Promise<void>;
  onSetProjectTrusted: (projectId: string, trusted: boolean) => void;
}

const byRecent = (a: Thread, b: Thread) => b.updatedAt - a.updatedAt;

/** Case-insensitive title match; blank query matches everything. */
export function matchesQuery(thread: Thread, query: string): boolean {
  const q = query.trim().toLocaleLowerCase();
  return q.length === 0 || thread.title.toLocaleLowerCase().includes(q);
}

/**
 * Codex-style sidebar: brand + search, nav (새 채팅 / 검색 / 계정), 고정된 스레드, 프로젝트 ▾ with each folder's
 * threads (newest first), and a collapsed 보관됨 list. Pure props (memoized; pass stable callbacks).
 */
export const Sidebar = memo(function Sidebar({
  projects,
  threads,
  accounts,
  selectedThreadId,
  draftActive,
  accountsActive,
  settingsActive,
  unseenDone,
  footer,
  onNewChat,
  onNewChatIn,
  onOpenAccounts,
  onOpenSettings,
  onAddProject,
  onRemoveProject,
  onSetProjectTrusted,
  ...rowHandlers
}: SidebarProps) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [projectsCollapsed, setProjectsCollapsed] = useState(false);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const filtering = searchOpen && query.trim().length > 0;
  const now = useMinuteClock();

  useEffect(() => {
    if (searchOpen) searchRef.current?.focus();
  }, [searchOpen]);

  const closeSearch = () => {
    setSearchOpen(false);
    setQuery('');
  };
  const toggleSearch = () => (searchOpen ? closeSearch() : setSearchOpen(true));

  const { pinned, byProject, archived } = useMemo(() => {
    const visible = threads.filter((t) => matchesQuery(t, filtering ? query : ''));
    const map = new Map<string, Thread[]>();
    for (const t of visible) {
      if (t.archived || t.pinned) continue;
      const bucket = map.get(t.projectId);
      if (bucket) bucket.push(t);
      else map.set(t.projectId, [t]);
    }
    for (const bucket of map.values()) bucket.sort(byRecent);
    return {
      pinned: visible.filter((t) => t.pinned && !t.archived).sort(byRecent),
      byProject: map,
      archived: visible.filter((t) => t.archived).sort(byRecent),
    };
  }, [threads, query, filtering]);

  const shownProjects = filtering ? projects.filter((p) => (byProject.get(p.id)?.length ?? 0) > 0) : projects;
  const nothingFound = filtering && pinned.length === 0 && shownProjects.length === 0 && archived.length === 0;
  const accountFor = (t: Thread) => (t.pinnedAccountId ? accounts.find((a) => a.id === t.pinnedAccountId) : undefined);

  return (
    <div className="hc-sidebar">
      <div className="hc-sidebar__header">
        <div className="hc-sidebar__brand" data-testid="brand">
          <BrandMark size={20} />
          <span className="hc-sidebar__wordmark">
            Hope<span className="hc-sidebar__wordmark-code">code</span>
          </span>
        </div>
        <button
          type="button"
          className={`hc-sidebar__icon-btn${searchOpen ? ' hc-sidebar__icon-btn--on' : ''}`}
          aria-label="스레드 검색"
          aria-pressed={searchOpen}
          title="스레드 검색"
          onClick={toggleSearch}
        >
          <IconSearch width={16} height={16} />
        </button>
      </div>

      <nav className="hc-sidebar__nav" aria-label="탐색">
        <button
          type="button"
          className={`hc-nav${draftActive ? ' hc-nav--active' : ''}`}
          aria-current={draftActive ? 'page' : undefined}
          onClick={onNewChat}
        >
          <IconCompose />
          <span className="hc-nav__label">새 채팅</span>
          <kbd className="hc-nav__kbd">⌘N</kbd>
        </button>
        <button type="button" className={`hc-nav${searchOpen ? ' hc-nav--active' : ''}`} aria-expanded={searchOpen} onClick={toggleSearch}>
          <IconSearch />
          <span className="hc-nav__label">검색</span>
        </button>
        <button
          type="button"
          className={`hc-nav${accountsActive ? ' hc-nav--active' : ''}`}
          aria-current={accountsActive ? 'page' : undefined}
          onClick={onOpenAccounts}
        >
          <IconPeople />
          <span className="hc-nav__label">계정</span>
          <span className="hc-nav__meta">
            {accounts.filter((a) => a.enabled).length}/{accounts.length}
          </span>
        </button>
        <button
          type="button"
          className={`hc-nav${settingsActive ? ' hc-nav--active' : ''}`}
          aria-current={settingsActive ? 'page' : undefined}
          onClick={onOpenSettings}
        >
          <GlyphSettings width={17} height={17} />
          <span className="hc-nav__label">설정</span>
          <kbd className="hc-nav__kbd">⌘,</kbd>
        </button>
      </nav>

      {searchOpen ? (
        <div className="hc-sidebar__search">
          <IconSearch width={14} height={14} className="hc-sidebar__search-icon" />
          <input
            ref={searchRef}
            type="search"
            className="hc-sidebar__search-input"
            placeholder="스레드 제목 검색"
            aria-label="스레드 제목 검색"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                closeSearch();
              }
            }}
          />
          <button type="button" className="hc-sidebar__search-clear" aria-label="검색 닫기" onClick={closeSearch}>
            <IconClose width={12} height={12} />
          </button>
        </div>
      ) : null}

      <div className="hc-sidebar__scroll">
        {nothingFound ? <div className="hc-sidebar__none">“{query.trim()}”와 일치하는 스레드가 없습니다</div> : null}

        {pinned.length > 0 ? (
          <section className="hc-section" aria-label="고정된 스레드">
            <div className="hc-section__header">
              <span className="hc-section__title">고정된 스레드</span>
            </div>
            <ul className="hc-section__list">
              {pinned.map((t) => (
                <ThreadRow
                  key={t.id}
                  glyph={<IconPinThread width={15} height={15} />}
                  thread={t}
                  account={accountFor(t)}
                  selected={t.id === selectedThreadId}
                  onSelect={rowHandlers.onSelectThread}
                  onRename={rowHandlers.onRenameThread}
                  onSetPinned={rowHandlers.onSetPinned}
                  onSetArchived={rowHandlers.onSetArchived}
                  onDelete={rowHandlers.onDeleteThread}
                  done={unseenDone[t.id] === true}
                  now={now}
                />
              ))}
            </ul>
          </section>
        ) : null}

        {nothingFound || (filtering && shownProjects.length === 0) ? null : (
          <section className="hc-section" aria-label="프로젝트">
            <div className="hc-section__header">
              <button
                type="button"
                className="hc-section__toggle"
                aria-expanded={!projectsCollapsed}
                onClick={() => setProjectsCollapsed((v) => !v)}
              >
                <span className="hc-section__title">프로젝트</span>
                <IconChevron
                  width={11}
                  height={11}
                  className={`hc-section__chevron${projectsCollapsed ? ' hc-section__chevron--collapsed' : ''}`}
                />
              </button>
              <button
                type="button"
                className="hc-section__action"
                aria-label="프로젝트 추가"
                title="폴더를 프로젝트로 추가"
                onClick={onAddProject}
              >
                <IconFolderPlus />
              </button>
            </div>
            {projectsCollapsed ? null : projects.length === 0 ? (
              <div className="hc-sidebar__empty">
                <p>아직 프로젝트가 없어요</p>
                <p className="hc-sidebar__empty-sub">새 채팅에서 폴더를 고르면 여기에 추가됩니다.</p>
              </div>
            ) : (
              shownProjects.map((project) => (
                <ProjectGroup
                  key={project.id}
                  project={project}
                  threads={byProject.get(project.id) ?? []}
                  accounts={accounts}
                  selectedThreadId={selectedThreadId}
                  filtering={filtering}
                  onNewChatIn={onNewChatIn}
                  onRemoveProject={onRemoveProject}
                  onSetTrusted={onSetProjectTrusted}
                  unseenDone={unseenDone}
                  now={now}
                  {...rowHandlers}
                />
              ))
            )}
          </section>
        )}

        {archived.length > 0 ? (
          <section className="hc-section hc-section--archived" aria-label="보관된 스레드">
            <div className="hc-section__header">
              <button
                type="button"
                className="hc-section__toggle"
                aria-expanded={archivedOpen || filtering}
                onClick={() => setArchivedOpen((v) => !v)}
              >
                <span className="hc-section__title">보관됨</span>
                <span className="hc-section__count">{archived.length}</span>
                <IconChevron
                  width={11}
                  height={11}
                  className={`hc-section__chevron${archivedOpen || filtering ? '' : ' hc-section__chevron--collapsed'}`}
                />
              </button>
            </div>
            {archivedOpen || filtering ? (
              <ul className="hc-section__list">
                {archived.map((t) => (
                  <ThreadRow
                    key={t.id}
                    glyph={<IconArchive width={15} height={15} />}
                    thread={t}
                    account={accountFor(t)}
                    selected={t.id === selectedThreadId}
                    onSelect={rowHandlers.onSelectThread}
                    onRename={rowHandlers.onRenameThread}
                    onSetPinned={rowHandlers.onSetPinned}
                    onSetArchived={rowHandlers.onSetArchived}
                    onDelete={rowHandlers.onDeleteThread}
                    done={unseenDone[t.id] === true}
                    now={now}
                  />
                ))}
              </ul>
            ) : null}
          </section>
        ) : null}
      </div>
      {footer}
    </div>
  );
});

/** Minute-aligned clock for the relative "3분 전" labels (one timer for the whole list). */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), MINUTE_MS / 2);
    return () => window.clearInterval(id);
  }, []);
  return now;
}
