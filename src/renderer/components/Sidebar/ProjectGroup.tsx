import { memo, useRef, useState, type MouseEvent } from 'react';
import type { Account, Project, Thread } from '../../../shared/types';
import { IconChevron, IconFolder, IconMore, IconPlusSmall, IconShieldAlert } from './icons';
import { ActionMenu, ConfirmDeletePopover, type NEEDS_FORCE } from './ItemMenu';
import { ThreadRow } from './ThreadRow';

export const UNTRUSTED_PROJECT_HINT = '신뢰하지 않음: 저장소 .claude 설정 비활성';

export interface ThreadRowHandlers {
  onSelectThread: (threadId: string) => void;
  onRenameThread: (threadId: string, title: string) => Promise<void>;
  onSetPinned: (threadId: string, pinned: boolean) => void;
  onSetArchived: (threadId: string, archived: boolean) => void;
  onDeleteThread: (threadId: string, force: boolean) => Promise<typeof NEEDS_FORCE | void>;
}

/** Row presentation shared by every list: unseen finished turns and the minute clock for relative times. */
export interface ThreadRowView {
  unseenDone: Readonly<Record<string, true>>;
  now: number;
}

export interface ProjectGroupProps extends ThreadRowHandlers, ThreadRowView {
  project: Project;
  /** Visible threads (not archived / pinned), newest activity first. */
  threads: Thread[];
  accounts: Account[];
  selectedThreadId: string | null;
  /** Search is active: groups start expanded and empty groups say so differently. */
  filtering?: boolean;
  onNewChatIn: (projectId: string) => void;
  onRemoveProject: (projectId: string) => Promise<void>;
  onSetTrusted: (projectId: string, trusted: boolean) => void;
}

/** Collapsible project (folder) with its threads, trust badge and Trust / Remove menu. */
export const ProjectGroup = memo(function ProjectGroup({
  project,
  threads,
  accounts,
  selectedThreadId,
  filtering = false,
  onSelectThread,
  onRenameThread,
  onSetPinned,
  onSetArchived,
  onDeleteThread,
  onNewChatIn,
  onRemoveProject,
  onSetTrusted,
  unseenDone,
  now,
}: ProjectGroupProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const headerRef = useRef<HTMLDivElement>(null);
  const untrusted = project.trusted === false;
  const expanded = filtering || !collapsed;

  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    setMenuOpen(true);
  };

  return (
    <div className={`hc-project${untrusted ? ' hc-project--untrusted' : ''}`}>
      <div ref={headerRef} className="hc-project__header" onContextMenu={onContextMenu}>
        <button
          type="button"
          className="hc-project__toggle"
          aria-expanded={expanded}
          title={project.path}
          onClick={() => setCollapsed((v) => !v)}
        >
          <span className="hc-project__glyph" aria-hidden>
            <IconFolder className="hc-project__icon" width={16} height={16} />
            <IconChevron className={`hc-project__chevron${expanded ? '' : ' hc-project__chevron--collapsed'}`} />
          </span>
          <span className="hc-project__name">{project.name}</span>
        </button>
        {untrusted ? (
          <button
            type="button"
            className="hc-project__untrusted"
            aria-label={UNTRUSTED_PROJECT_HINT}
            title={`${UNTRUSTED_PROJECT_HINT}. 눌러서 검토하세요.`}
            onClick={() => setMenuOpen(true)}
          >
            <IconShieldAlert width={13} height={13} />
          </button>
        ) : null}
        <button
          type="button"
          className="hc-project__add"
          aria-label={`${project.name} 작업`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          title="프로젝트 작업"
          onClick={() => setMenuOpen((v) => !v)}
        >
          <IconMore />
        </button>
        <button
          type="button"
          className="hc-project__add"
          aria-label={`${project.name}에서 새 채팅`}
          title="이 폴더에서 새 채팅"
          onClick={() => onNewChatIn(project.id)}
        >
          <IconPlusSmall />
        </button>
      </div>
      <ActionMenu
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        anchorRef={headerRef}
        label="프로젝트 작업"
        actions={[
          { label: '이 폴더에서 새 채팅', onSelect: () => onNewChatIn(project.id) },
          untrusted
            ? { label: '프로젝트 신뢰', onSelect: () => onSetTrusted(project.id, true) }
            : { label: '신뢰 해제', onSelect: () => onSetTrusted(project.id, false) },
          { label: '프로젝트 제거…', destructive: true, onSelect: () => setConfirmOpen(true) },
        ]}
      />
      <ConfirmDeletePopover
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        anchorRef={headerRef}
        label="프로젝트 제거"
        message={`“${project.name}”을(를) Hopecode에서 제거할까요? 스레드와 worktree는 삭제되고 폴더 자체는 남습니다.`}
        confirmLabel="제거"
        onConfirm={() => onRemoveProject(project.id)}
      />
      {expanded ? (
        <ul className="hc-project__threads" aria-label={`${project.name} 스레드`}>
          {threads.length === 0 ? (
            <li className="hc-project__empty">{filtering ? '일치하는 스레드 없음' : '스레드 없음'}</li>
          ) : (
            threads.map((thread) => (
              <ThreadRow
                key={thread.id}
                nested
                thread={thread}
                account={thread.pinnedAccountId ? accounts.find((a) => a.id === thread.pinnedAccountId) : undefined}
                selected={thread.id === selectedThreadId}
                onSelect={onSelectThread}
                onRename={onRenameThread}
                onSetPinned={onSetPinned}
                onSetArchived={onSetArchived}
                onDelete={onDeleteThread}
                done={unseenDone[thread.id] === true}
                now={now}
              />
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
});
