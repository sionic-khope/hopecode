import { memo, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import type { Account, Thread } from '../../../shared/types';
import { formatResetCountdown } from '../../../core/format';
import { IconArchive, IconPinThread, IconSpinner, IconUnarchive } from './icons';
import { ActionMenu, ConfirmDeletePopover, type NEEDS_FORCE } from './ItemMenu';

export interface ThreadRowProps {
  thread: Thread;
  /** Resolved from `thread.pinnedAccountId`; undefined when not pinned to an account. */
  account?: Account;
  selected: boolean;
  /** Indented under a project header. */
  nested?: boolean;
  /**
   * Icon in the 17px leading slot (pinned / archived sections). Every row keeps the slot, so all titles start
   * at the same x as the project names.
   */
  glyph?: ReactNode;
  onSelect: (threadId: string) => void;
  onRename: (threadId: string, title: string) => Promise<void>;
  onSetPinned: (threadId: string, pinned: boolean) => void;
  onSetArchived: (threadId: string, archived: boolean) => void;
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
}: ThreadRowProps) {
  const now = useNow(thread.status === 'waiting');
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
      void onRename(thread.id, title).catch((err: unknown) => console.error('[hopecode] rename failed', err));
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

  const status =
    thread.status === 'running' ? (
      <span className="hc-thread__status" title="실행 중" aria-label="실행 중">
        <IconSpinner />
      </span>
    ) : thread.status === 'waiting' ? (
      <span className="hc-thread__meta hc-thread__meta--waiting" title="한도 초기화까지 대기 중">
        {countdown ?? '대기 중'}
      </span>
    ) : thread.status === 'error' ? (
      <span className="hc-thread__status hc-thread__status--error" title="오류" aria-label="오류" />
    ) : null;

  return (
    <li
      ref={wrapRef}
      className={`hc-thread-wrap${nested ? ' hc-thread-wrap--nested' : ''}${thread.archived ? ' hc-thread-wrap--archived' : ''}`}
      onContextMenu={onContextMenu}
    >
      {renaming ? (
        <input
          className="hc-thread__rename"
          aria-label="스레드 이름"
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
        >
          <span className="hc-thread__glyph" aria-hidden>
            {glyph}
          </span>
          <span className="hc-thread__title">{thread.title}</span>
          <span className="hc-thread__trail">
            {account ? (
              <span
                className="hc-thread__account"
                style={{ background: account.color }}
                title={`${account.alias} 계정으로 고정됨`}
                aria-label={`${account.alias} 계정으로 고정됨`}
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
              aria-label={thread.pinned ? `${thread.title} 고정 해제` : `${thread.title} 고정`}
              aria-pressed={thread.pinned}
              title={thread.pinned ? '고정 해제' : '고정'}
              onClick={() => onSetPinned(thread.id, !thread.pinned)}
            >
              <IconPinThread filled={thread.pinned} />
            </button>
          )}
          <button
            type="button"
            className="hc-thread__action"
            aria-label={thread.archived ? `${thread.title} 보관 해제` : `${thread.title} 보관`}
            title={thread.archived ? '보관 해제' : '보관'}
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
        label="스레드 작업"
        actions={[
          { label: '이름 변경', onSelect: startRename },
          ...(thread.archived
            ? []
            : [{ label: thread.pinned ? '고정 해제' : '고정', onSelect: () => onSetPinned(thread.id, !thread.pinned) }]),
          { label: thread.archived ? '보관 해제' : '보관', onSelect: () => onSetArchived(thread.id, !thread.archived) },
          { label: '삭제…', destructive: true, onSelect: () => setConfirmOpen(true) },
        ]}
      />
      <ConfirmDeletePopover
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        anchorRef={wrapRef}
        label="스레드 삭제"
        message={
          thread.worktree
            ? `“${thread.title}”을(를) 삭제할까요? 대화 기록과 worktree(${thread.worktree.branch})가 삭제됩니다.`
            : `“${thread.title}”을(를) 삭제할까요? 대화 기록이 삭제됩니다.`
        }
        forceMessage="이 worktree에 커밋하지 않은 변경 사항이 있습니다. 그래도 삭제할까요?"
        confirmLabel="삭제"
        onConfirm={(force) => onDelete(thread.id, force)}
      />
    </li>
  );
});
