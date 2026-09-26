import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Account, Project, Thread } from '../../../shared/types';
import { BrandMark } from '../common';
import { IconArchive, IconChevron, IconFolderPlus, IconPinThread } from './icons';
import { ProjectGroup, type ThreadRowHandlers } from './ProjectGroup';
import { SidebarNav, type NavPage } from './SidebarNav';
import { MINUTE_MS } from '../../../shared/constants';
import { ThreadRow } from './ThreadRow';
import './Sidebar.css';

export interface SidebarProps extends ThreadRowHandlers {
  projects: Project[];
  threads: Thread[];
  accounts: Account[];
  selectedThreadId: string | null;
  /** Page the nav highlights (draft = the new chat screen). */
  activePage: NavPage;
  /** Threads with a finished turn not yet opened ("완료" pill). */
  unseenDone: Readonly<Record<string, true>>;
  /** Footer (profile row). */
  footer?: ReactNode;
  onNewChat: () => void;
  onNewChatIn: (projectId: string) => void;
  /** 검색 / ⌘K: the command palette on thread search. */
  onSearch: () => void;
  onOpenPrs: () => void;
  onOpenSchedule: () => void;
  onOpenPlugins: () => void;
  onOpenAccounts: () => void;
  onOpenUsage: () => void;
  onOpenSettings: () => void;
  onShowShortcuts: () => void;
  onShowAbout: () => void;
  onAddProject: () => void;
  onRemoveProject: (projectId: string) => Promise<void>;
  onSetProjectTrusted: (projectId: string, trusted: boolean) => void;
}

const byRecent = (a: Thread, b: Thread) => b.updatedAt - a.updatedAt;

/**
 * Codex-style sidebar: brand, nav (SidebarNav: 새 채팅 / 검색 / 풀 리퀘스트 / 예약 / 플러그인 / 더보기), 고정된 스레드,
 * 프로젝트 ▾ with each folder's threads (newest first), and a collapsed 보관됨 list. Thread search lives in the
 * command palette (⌘K). Pure props (memoized; pass stable callbacks).
 */
export const Sidebar = memo(function Sidebar({
  projects,
  threads,
  accounts,
  selectedThreadId,
  activePage,
  unseenDone,
  footer,
  onNewChat,
  onNewChatIn,
  onSearch,
  onOpenPrs,
  onOpenSchedule,
  onOpenPlugins,
  onOpenAccounts,
  onOpenUsage,
  onOpenSettings,
  onShowShortcuts,
  onShowAbout,
  onAddProject,
  onRemoveProject,
  onSetProjectTrusted,
  ...rowHandlers
}: SidebarProps) {
  const [projectsCollapsed, setProjectsCollapsed] = useState(false);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const archivedRef = useRef<HTMLElement>(null);
  const now = useMinuteClock();

  // 더보기 > 보관된 스레드: expand the section and bring it into view.
  const showArchived = useCallback(() => {
    setArchivedOpen(true);
    requestAnimationFrame(() => archivedRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  }, []);

  const { pinned, byProject, archived } = useMemo(() => {
    const map = new Map<string, Thread[]>();
    for (const t of threads) {
      if (t.archived || t.pinned) continue;
      const bucket = map.get(t.projectId);
      if (bucket) bucket.push(t);
      else map.set(t.projectId, [t]);
    }
    for (const bucket of map.values()) bucket.sort(byRecent);
    return {
      pinned: threads.filter((t) => t.pinned && !t.archived).sort(byRecent),
      byProject: map,
      archived: threads.filter((t) => t.archived).sort(byRecent),
    };
  }, [threads]);

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
      </div>

      <SidebarNav
        active={activePage}
        accounts={accounts}
        archivedCount={archived.length}
        onNewChat={onNewChat}
        onSearch={onSearch}
        onOpenPrs={onOpenPrs}
        onOpenSchedule={onOpenSchedule}
        onOpenPlugins={onOpenPlugins}
        onOpenAccounts={onOpenAccounts}
        onOpenUsage={onOpenUsage}
        onOpenSettings={onOpenSettings}
        onShowShortcuts={onShowShortcuts}
        onShowAbout={onShowAbout}
        onShowArchived={showArchived}
      />

      <div className="hc-sidebar__scroll">

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
            projects.map((project) => (
              <ProjectGroup
                key={project.id}
                project={project}
                threads={byProject.get(project.id) ?? []}
                accounts={accounts}
                selectedThreadId={selectedThreadId}
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

        {archived.length > 0 ? (
          <section ref={archivedRef} className="hc-section hc-section--archived" aria-label="보관된 스레드">
            <div className="hc-section__header">
              <button
                type="button"
                className="hc-section__toggle"
                aria-expanded={archivedOpen}
                onClick={() => setArchivedOpen((v) => !v)}
              >
                <span className="hc-section__title">보관됨</span>
                <span className="hc-section__count">{archived.length}</span>
                <IconChevron
                  width={11}
                  height={11}
                  className={`hc-section__chevron${archivedOpen ? '' : ' hc-section__chevron--collapsed'}`}
                />
              </button>
            </div>
            {archivedOpen ? (
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
