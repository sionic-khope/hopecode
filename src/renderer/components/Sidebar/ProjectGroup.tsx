import { memo, useRef, useState, type MouseEvent } from 'react';
import type { Account, Project, Thread } from '../../../shared/types';
import { IconChevron, IconFolder, IconMore, IconPlusSmall, IconShieldAlert } from './icons';
import { ActionMenu, ConfirmDeletePopover, type NEEDS_FORCE } from './ItemMenu';
import { ThreadRow } from './ThreadRow';

export const UNTRUSTED_PROJECT_HINT = 'Untrusted: repo .claude settings disabled';

export interface ProjectGroupProps {
  project: Project;
  threads: Thread[];
  accounts: Account[];
  selectedThreadId: string | null;
  onSelectThread: (threadId: string) => void;
  onNewThread: (projectId: string) => void;
  onRenameThread: (threadId: string, title: string) => Promise<void>;
  onDeleteThread: (threadId: string, force: boolean) => Promise<typeof NEEDS_FORCE | void>;
  onRemoveProject: (projectId: string) => Promise<void>;
  onSetTrusted: (projectId: string, trusted: boolean) => void;
}

/** Collapsible project group with its threads, trust badge and Trust / Remove menu (spec: App Shell / Thread-Session). */
export const ProjectGroup = memo(function ProjectGroup({
  project,
  threads,
  accounts,
  selectedThreadId,
  onSelectThread,
  onNewThread,
  onRenameThread,
  onDeleteThread,
  onRemoveProject,
  onSetTrusted,
}: ProjectGroupProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const headerRef = useRef<HTMLDivElement>(null);
  const untrusted = project.trusted === false;

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
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((v) => !v)}
        >
          <IconChevron className={`hc-project__chevron ${collapsed ? 'hc-project__chevron--collapsed' : ''}`} />
          <IconFolder className="hc-project__icon" />
          <span className="hc-project__name" title={project.path}>
            {project.name}
          </span>
        </button>
        {untrusted ? (
          <button
            type="button"
            className="hc-project__untrusted"
            aria-label={UNTRUSTED_PROJECT_HINT}
            title={`${UNTRUSTED_PROJECT_HINT}. Click to review.`}
            onClick={() => setMenuOpen(true)}
          >
            <IconShieldAlert width={12} height={12} />
          </button>
        ) : null}
        <button
          type="button"
          className="hc-project__add"
          aria-label={`Actions for ${project.name}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          title="Project actions"
          onClick={() => setMenuOpen((v) => !v)}
        >
          <IconMore />
        </button>
        <button
          type="button"
          className="hc-project__add"
          aria-label={`New thread in ${project.name}`}
          title="New Thread"
          onClick={() => onNewThread(project.id)}
        >
          <IconPlusSmall />
        </button>
      </div>
      <ActionMenu
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        anchorRef={headerRef}
        label="Project actions"
        actions={[
          untrusted
            ? { label: 'Trust Project', onSelect: () => onSetTrusted(project.id, true) }
            : { label: 'Revoke Trust', onSelect: () => onSetTrusted(project.id, false) },
          { label: 'Remove Project…', destructive: true, onSelect: () => setConfirmOpen(true) },
        ]}
      />
      <ConfirmDeletePopover
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        anchorRef={headerRef}
        label="Remove project"
        message={`Remove “${project.name}” from Hopecode? Its threads and worktrees are deleted; the folder itself is kept.`}
        confirmLabel="Remove"
        onConfirm={() => onRemoveProject(project.id)}
      />
      {collapsed ? null : (
        <div className="hc-project__threads" role="listbox" aria-label={`${project.name} threads`}>
          {threads.length === 0 ? (
            <div className="hc-project__empty">No threads yet</div>
          ) : (
            threads.map((thread) => (
              <ThreadRow
                key={thread.id}
                thread={thread}
                account={thread.pinnedAccountId ? accounts.find((a) => a.id === thread.pinnedAccountId) : undefined}
                selected={thread.id === selectedThreadId}
                onSelect={onSelectThread}
                onRename={onRenameThread}
                onDelete={onDeleteThread}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
});
