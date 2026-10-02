import { memo, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import type { Account, Thread } from '../../../shared/types';
import { formatRelativeTime, formatResetCountdown } from '../../../core/format';
import { AGENTS } from '../../../shared/agents';
import { StatusPill } from '../common';
import { AgentIcon } from '../Agent/AgentIcon';
import { IconArchive, IconPinThread, IconUnarchive } from './icons';
import { ActionMenu, ConfirmDeletePopover, type NEEDS_FORCE } from './ItemMenu';
import { useLanguage } from '../../i18n';
import { formatDate, t } from '../../../shared/i18n';

export interface ThreadRowProps {
  thread: Thread;
  /** Resolved from `thread.pinnedAccountId`; undefined when not pinned to an account. */
  account?: Account;
  selected: boolean;
  /** Indented under a project header. */
  nested?: boolean;
  /**
   * Icon in the 17px leading slot; defaults to the thread's agent logo (archived rows pass their own glyph). Every
   * row keeps the slot, so all titles start at the same x as the project names.
   */
  glyph?: ReactNode;
  onSelect: (threadId: string) => void;
  onRename: (threadId: string, title: string) => Promise<void>;
  onSetPinned: (threadId: string, pinned: boolean) => void;
  onSetArchived: (threadId: string, archived: boolean) => void;
  /** Resolves NEEDS_FORCE when the worktree has uncommitted changes; `force` discards them. */
  onDelete: (threadId: string, force: boolean) => Promise<typeof NEEDS_FORCE | void>;
  /** A turn finished while the thread was not open (green "완료" pill until it is opened). */
  done?: boolean;
  /** Minute clock from the sidebar (relative "3분 전" labels). */
  now?: number;
}

/** Re-renders every 30s while waiting, so the countdown label stays fresh without a global clock. */
function useNow(active: boolean, intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs]);
  return now;
}

/**
 * Sidebar thread row: one-line title, running spinner / waiting countdown, hover pin + archive buttons, and a
 * context menu (right-click, ContextMenu key or ⇧F10) with 이름 변경 / 고정 / 보관 / 삭제.
 */
export const ThreadRow = memo(function ThreadRow({
  thread,
  account,
  selected,
  nested = false,
  glyph = null,
  onSelect,
  onRename,
  onSetPinned,
  onSetArchived,
  onDelete,
  done = false,
  now: listNow,
}: ThreadRowProps) {
  useLanguage();
  const waitNow = useNow(thread.status === 'waiting');
  const now = Math.max(waitNow, listNow ?? 0);
  const wrapRef = useRef<HTMLLIElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(thread.title);
  // Enter commits and unmounts the input, which may also fire blur: commit once per rename.
  const renameOpen = useRef(false);

  const countdown = thread.status === 'waiting' ? formatResetCountdown(thread.waitingUntil, now) : null;

  const startRename = () => {
    setDraft(thread.title);
    renameOpen.current = true;
    setRenaming(true);
  };

  const commitRename = () => {
    if (!renameOpen.current) return;
    renameOpen.current = false;
    setRenaming(false);
    const title = draft.trim();
    if (title && title !== thread.title) {
      void onRename(thread.id, title).catch((err: unknown) => console.error('[deltax] rename failed', err));
    }
  };

  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    setMenuOpen(true);
  };

  const onRowKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
      e.preventDefault();
      setMenuOpen(true);
    }
  };

  // Run state as a pastel pill; an idle thread shows how long ago it was active instead.
  const status =
    thread.status === 'running' ? (
      <StatusPill state="running" className="hc-thread__pill" title={t('status.running')} />
    ) : thread.status === 'waiting' ? (
      <StatusPill state="waiting" className="hc-thread__pill hc-thread__meta hc-thread__meta--waiting" title={t('thread.waitingReset')}>
        {countdown ?? t('status.waiting')}
      </StatusPill>
    ) : thread.status === 'error' ? (
      <StatusPill state="error" className="hc-thread__pill" title={t('status.error')} />
    ) : done ? (
      <StatusPill state="done" className="hc-thread__pill" title={t('thread.newReply')} />
    ) : (
      <span className="hc-thread__time" title={formatDate(thread.updatedAt, { dateStyle: 'medium', timeStyle: 'short' })}>
        {formatRelativeTime(thread.updatedAt, now)}
      </span>
    );

  return (
    <li
      ref={wrapRef}
      className={`hc-thread-wrap${nested ? ' hc-thread-wrap--nested' : ''}${thread.archived ? ' hc-thread-wrap--archived' : ''}`}
      onContextMenu={onContextMenu}
    >
      {renaming ? (
        <input
          className="hc-thread__rename"
          aria-label={t('header.threadName')}
          value={draft}
          maxLength={120}
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.key === 'Enter') commitRename();
            if (e.key === 'Escape') {
              renameOpen.current = false;
              setRenaming(false);
            }
          }}
        />
      ) : (
        <button
          type="button"
          aria-current={selected ? 'page' : undefined}
          className={`hc-thread${selected ? ' hc-thread--selected' : ''}`}
          title={thread.title}
          onClick={() => onSelect(thread.id)}
          onDoubleClick={startRename}
          onKeyDown={onRowKeyDown}
          data-agent={thread.agent}
        >
          <span
            className={`hc-thread__glyph${glyph ? '' : ' hc-thread__glyph--agent'}`}
            data-agent={thread.agent}
            title={glyph ? undefined : AGENTS[thread.agent].name}
            aria-hidden
          >
            {glyph ?? <AgentIcon kind={thread.agent} size={15} />}
          </span>
          <span className="hc-thread__title">{thread.title}</span>
          <span className="hc-thread__trail">
            {account ? (
              <span
                className="hc-thread__account"
                style={{ background: account.color }}
                title={t('thread.pinnedAccount', { alias: account.alias })}
                aria-label={t('thread.pinnedAccount', { alias: account.alias })}
              />
            ) : null}
            {status}
          </span>
        </button>
      )}
      {renaming ? null : (
        <span className="hc-thread__actions">
          {thread.archived ? null : (
            <button
              type="button"
              className={`hc-thread__action${thread.pinned ? ' hc-thread__action--on' : ''}`}
              aria-label={`${thread.title} ${thread.pinned ? t('thread.unpin') : t('thread.pin')}`}
              aria-pressed={thread.pinned}
              title={thread.pinned ? t('thread.unpin') : t('thread.pin')}
              onClick={() => onSetPinned(thread.id, !thread.pinned)}
            >
              <IconPinThread filled={thread.pinned} />
            </button>
          )}
          <button
            type="button"
            className="hc-thread__action"
            aria-label={`${thread.title} ${thread.archived ? t('thread.unarchive') : t('thread.archive')}`}
            title={thread.archived ? t('thread.unarchive') : t('thread.archive')}
            onClick={() => onSetArchived(thread.id, !thread.archived)}
          >
            {thread.archived ? <IconUnarchive /> : <IconArchive />}
          </button>
        </span>
      )}
      <ActionMenu
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        anchorRef={wrapRef}
        label={t('thread.actions')}
        actions={[
          { label: t('acct.rename'), onSelect: startRename },
          ...(thread.archived
            ? []
            : [{ label: thread.pinned ? t('thread.unpin') : t('thread.pin'), onSelect: () => onSetPinned(thread.id, !thread.pinned) }]),
          { label: thread.archived ? t('thread.unarchive') : t('thread.archive'), onSelect: () => onSetArchived(thread.id, !thread.archived) },
          { label: t('thread.deleteEllipsis'), destructive: true, onSelect: () => setConfirmOpen(true) },
        ]}
      />
      <ConfirmDeletePopover
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        anchorRef={wrapRef}
        label={t('thread.delete')}
        message={
          thread.worktree
            ? t('thread.delete.withWorktree', { title: thread.title, branch: thread.worktree.branch })
            : t('thread.delete.message', { title: thread.title })
        }
        forceMessage={t('thread.delete.force')}
        confirmLabel={t('common.delete')}
        onConfirm={(force) => onDelete(thread.id, force)}
      />
    </li>
  );
});
