import { memo, useEffect, useRef, useState } from 'react';
import type { Thread } from '../../../shared/types';
import { formatResetCountdown } from '../../../core/format';
import { StatusPill } from '../common';
import { WindowToolbar, type WindowToolbarProps } from './WindowToolbar';
import './Shell.css';

export interface ChatHeaderProps extends Omit<WindowToolbarProps, 'thread' | 'onStartRename'> {
  thread: Thread;
  onRename: (title: string) => Promise<void>;
}

/** Title (click or 더보기 > 이름 변경 to rename), project, run-state pill; the window toolbar on the right. */
export const ChatHeader = memo(function ChatHeader({ thread, onRename, ...toolbar }: ChatHeaderProps) {
  const project = toolbar.project;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(thread.title);
  const committing = useRef(false);

  useEffect(() => {
    if (!editing) setDraft(thread.title);
  }, [thread.title, editing]);

  const startRename = () => {
    committing.current = true;
    setEditing(true);
  };

  const commit = () => {
    if (!committing.current) return;
    committing.current = false;
    setEditing(false);
    const title = draft.trim();
    if (title && title !== thread.title) void onRename(title).catch((err: unknown) => console.error('[hopecode] rename failed', err));
  };

  const state =
    thread.status === 'running' ? 'running' : thread.status === 'waiting' ? 'waiting' : thread.status === 'error' ? 'error' : null;
  const waitingText = thread.status === 'waiting' ? formatResetCountdown(thread.waitingUntil, Date.now()) : null;

  return (
    <div className="hc-chat-header">
      <div className="app__thread-title">
        {editing ? (
          <input
            className="hc-chat-header__rename no-drag"
            aria-label="스레드 이름"
            value={draft}
            maxLength={120}
            autoFocus
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.key === 'Enter') commit();
              if (e.key === 'Escape') {
                committing.current = false;
                setEditing(false);
              }
            }}
          />
        ) : (
          <button
            type="button"
            className="app__thread-name no-drag"
            title="클릭해서 이름 변경"
            aria-label={`스레드 이름: ${thread.title} (이름 변경)`}
            onClick={startRename}
          >
            {thread.title}
          </button>
        )}
        {project ? <span className="app__thread-project">{project.name}</span> : null}
        {state ? (
          <StatusPill state={state} className="hc-chat-header__status">
            {state === 'waiting' && waitingText ? `대기 중 · ${waitingText}` : undefined}
          </StatusPill>
        ) : null}
      </div>
      <WindowToolbar {...toolbar} thread={thread} onStartRename={startRename} />
    </div>
  );
});
