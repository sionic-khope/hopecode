import { memo, useEffect, useRef, useState, type MouseEvent } from 'react';
import type { Account, Thread } from '../../../shared/types';
import { formatResetCountdown } from '../../../core/format';
import { IconMore, IconPin } from './icons';
import { ActionMenu, ConfirmDeletePopover, type NEEDS_FORCE } from './ItemMenu';

export interface ThreadRowProps {
  thread: Thread;
  /** Resolved from `thread.pinnedAccountId`; undefined when not pinned. */
  account?: Account;
  selected: boolean;
  onSelect: (threadId: string) => void;
  onRename: (threadId: string, title: string) => Promise<void>;
  /** Resolves NEEDS_FORCE when the worktree has uncommitted changes; `force` discards them. */
  onDelete: (threadId: string, force: boolean) => Promise<typeof NEEDS_FORCE | void>;
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
 * Sidebar thread item: status dot (running/waiting/idle/error), title, waiting countdown, pin, and a
 * Rename / Delete menu (hover "…" button or right-click).
 */
export const ThreadRow = memo(function ThreadRow({ thread, account, selected, onSelect, onRename, onDelete }: ThreadRowProps) {
  const now = useNow(thread.status === 'waiting');
  const wrapRef = useRef<HTMLDivElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(thread.title);
  // Enter commits and unmounts the input, which may also fire blur: commit once per rename.
  const renameOpen = useRef(false);

  const waitingLabel =
    thread.status === 'waiting'
      ? (() => {
          const countdown = formatResetCountdown(thread.waitingUntil, now);
          return countdown ? `Waiting · ${countdown}` : 'Waiting';
        })()
      : null;

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
      void onRename(thread.id, title).catch((err: unknown) => console.error('[hopecode] rename failed', err));
    }
  };

  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    setMenuOpen(true);
  };

  return (
    <div ref={wrapRef} className="hc-thread-wrap" onContextMenu={onContextMenu}>
      {renaming ? (
        <input
          className="hc-thread__rename"
          aria-label="Thread name"
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
          role="option"
          aria-selected={selected}
          className={`hc-thread ${selected ? 'hc-thread--selected' : ''}`}
          onClick={() => onSelect(thread.id)}
          onDoubleClick={startRename}
        >
          <span className={`hc-thread__dot hc-thread__dot--${thread.status}`} aria-hidden />
          <span className="hc-thread__title">{thread.title}</span>
          {waitingLabel ? <span className="hc-thread__meta hc-thread__meta--waiting">{waitingLabel}</span> : null}
          {account ? (
            <span className="hc-thread__pin" style={{ color: account.color }} title={`Pinned to ${account.alias}`}>
              <IconPin />
            </span>
          ) : null}
        </button>
      )}
      {renaming ? null : (
        <button
          type="button"
          className="hc-thread__more"
          aria-label={`Actions for ${thread.title}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((v) => !v)}
        >
          <IconMore />
        </button>
      )}
      <ActionMenu
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        anchorRef={wrapRef}
        label="Thread actions"
        actions={[
          { label: 'Rename', onSelect: startRename },
          { label: 'Delete…', destructive: true, onSelect: () => setConfirmOpen(true) },
        ]}
      />
      <ConfirmDeletePopover
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        anchorRef={wrapRef}
        label="Delete thread"
        message={
          thread.worktree
            ? `Delete “${thread.title}”? Its transcript and worktree (${thread.worktree.branch}) are removed.`
            : `Delete “${thread.title}”? Its transcript is removed.`
        }
        forceMessage="This worktree has uncommitted changes. Delete it anyway?"
        confirmLabel="Delete"
        onConfirm={(force) => onDelete(thread.id, force)}
      />
    </div>
  );
});
