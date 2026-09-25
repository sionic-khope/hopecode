import { memo, useMemo } from 'react';
import type { Account, Project, Thread } from '../../../shared/types';
import { Button } from '../common';
import { IconAccounts, IconFolderPlus, IconThreadPlus } from './icons';
import type { NEEDS_FORCE } from './ItemMenu';
import { ProjectGroup } from './ProjectGroup';
import './Sidebar.css';

export interface SidebarProps {
  projects: Project[];
  threads: Thread[];
  accounts: Account[];
  selectedThreadId: string | null;
  onSelectThread: (threadId: string) => void;
  onNewThread: (projectId: string) => void;
  onRenameThread: (threadId: string, title: string) => Promise<void>;
  /** Resolves NEEDS_FORCE when the worktree has uncommitted changes; `force` discards them. */
  onDeleteThread: (threadId: string, force: boolean) => Promise<typeof NEEDS_FORCE | void>;
  onRemoveProject: (projectId: string) => Promise<void>;
  onSetProjectTrusted: (projectId: string, trusted: boolean) => void;
  onAddProject: () => void;
  onOpenAccounts: () => void;
  /** Highlights the footer entry when the Accounts route is active. */
  accountsActive?: boolean;
}

/**
 * Thread sidebar: project groups (collapsible), thread rows with status dots,
 * + New Thread / Add Project, and the Accounts entry point (plan 4.4, spec App Shell).
 * Pure props (memoized; pass stable callbacks) — App connects the store.
 */
export const Sidebar = memo(function Sidebar({
  projects,
  threads,
  accounts,
  selectedThreadId,
  onSelectThread,
  onNewThread,
  onRenameThread,
  onDeleteThread,
  onRemoveProject,
  onSetProjectTrusted,
  onAddProject,
  onOpenAccounts,
  accountsActive = false,
}: SidebarProps) {
  const threadsByProject = useMemo(() => {
    const map = new Map<string, Thread[]>();
    for (const thread of threads) {
      const bucket = map.get(thread.projectId);
      if (bucket) bucket.push(thread);
      else map.set(thread.projectId, [thread]);
    }
    return map;
  }, [threads]);

  const defaultProjectId = useMemo(() => {
    const selected = threads.find((t) => t.id === selectedThreadId);
    return selected?.projectId ?? projects[0]?.id ?? null;
  }, [threads, selectedThreadId, projects]);

  return (
    <div className="hc-sidebar">
      <div className="hc-sidebar__header">
        <span className="hc-sidebar__title">Projects</span>
        <div className="hc-sidebar__header-actions">
          <Button variant="plain" size="sm" icon aria-label="Add project" title="Add Project" onClick={onAddProject}>
            <IconFolderPlus />
          </Button>
          <Button
            variant="plain"
            size="sm"
            icon
            aria-label="New thread"
            title="New Thread"
            disabled={!defaultProjectId}
            onClick={() => {
              if (defaultProjectId) onNewThread(defaultProjectId);
            }}
          >
            <IconThreadPlus />
          </Button>
        </div>
      </div>

      <nav className="hc-sidebar__scroll" aria-label="Projects and threads">
        {projects.length === 0 ? (
          <div className="hc-sidebar__empty">
            <p>No projects yet</p>
            <Button variant="secondary" size="sm" onClick={onAddProject}>
              Add Project
            </Button>
          </div>
        ) : (
          projects.map((project) => (
            <ProjectGroup
              key={project.id}
              project={project}
              threads={threadsByProject.get(project.id) ?? []}
              accounts={accounts}
              selectedThreadId={selectedThreadId}
              onSelectThread={onSelectThread}
              onNewThread={onNewThread}
              onRenameThread={onRenameThread}
              onDeleteThread={onDeleteThread}
              onRemoveProject={onRemoveProject}
              onSetTrusted={onSetProjectTrusted}
            />
          ))
        )}
      </nav>

      <div className="hc-sidebar__footer">
        <button
          type="button"
          className={`hc-sidebar__accounts ${accountsActive ? 'hc-sidebar__accounts--active' : ''}`}
          onClick={onOpenAccounts}
        >
          <IconAccounts />
          <span>Accounts</span>
        </button>
      </div>
    </div>
  );
});
