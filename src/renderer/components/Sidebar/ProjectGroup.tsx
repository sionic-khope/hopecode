import { memo, useRef, useState, type MouseEvent } from 'react';
import type { Account, Project, Thread } from '../../../shared/types';
import { IconChevron, IconFolder, IconMore, IconPlusSmall, IconShieldAlert } from './icons';
import { ActionMenu, ConfirmDeletePopover, type NEEDS_FORCE } from './ItemMenu';
import { ThreadRow } from './ThreadRow';
import { useLanguage } from '../../i18n';
import { t } from '../../../shared/i18n';


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
  useLanguage();
  const [collapsed, setCollapsed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const headerRef = useRef<HTMLDivElement>(null);
  const untrusted = project.trusted === false;
  const expanded = !collapsed;

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
            aria-label={t('project.untrusted')}
            title={`${t('project.untrusted')}. ${t('project.untrusted.review')}`}
            onClick={() => setMenuOpen(true)}
          >
            <IconShieldAlert width={13} height={13} />
          </button>
        ) : null}
        <button
          type="button"
          className="hc-project__add"
          aria-label={t('project.actionsAria', { name: project.name })}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          title={t('project.actions')}
          onClick={() => setMenuOpen((v) => !v)}
        >
          <IconMore />
        </button>
        <button
          type="button"
          className="hc-project__add"
          aria-label={t('project.newChatAria', { name: project.name })}
          title={t('project.newChatHere')}
          onClick={() => onNewChatIn(project.id)}
        >
          <IconPlusSmall />
        </button>
      </div>
      <ActionMenu
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        anchorRef={headerRef}
        label={t('project.actions')}
        actions={[
          { label: t('project.newChatHere'), onSelect: () => onNewChatIn(project.id) },
          untrusted
            ? { label: t('project.trust'), onSelect: () => onSetTrusted(project.id, true) }
            : { label: t('project.untrust'), onSelect: () => onSetTrusted(project.id, false) },
          { label: t('project.removeEllipsis'), destructive: true, onSelect: () => setConfirmOpen(true) },
        ]}
      />
      <ConfirmDeletePopover
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        anchorRef={headerRef}
        label={t('project.remove')}
        message={t('project.remove.message', { name: project.name })}
        confirmLabel={t('project.remove.confirm')}
        onConfirm={() => onRemoveProject(project.id)}
      />
      {expanded ? (
        <ul className="hc-project__threads" aria-label={t('project.threadsAria', { name: project.name })}>
          {threads.length === 0 ? (
            <li className="hc-project__empty">{t('project.noThreads')}</li>
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
