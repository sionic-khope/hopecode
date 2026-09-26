import { memo, useEffect, useRef, useState } from 'react';
import type { EditorId, EditorInfo, Project, Thread } from '../../../shared/types';
import { formatResetCountdown } from '../../../core/format';
import { StatusPill } from '../common';
import { GlyphChanges, GlyphTerminal } from '../common/glyphs';
import { CommitMenu } from '../Changes/CommitMenu';
import type { PanelTab } from '../../store';
import { EditorMenu } from './EditorMenu';
import './Shell.css';

export interface ChatHeaderProps {
  thread: Thread;
  project: Project | null;
  panel: PanelTab | null;
  editors: EditorInfo[];
  defaultEditor: EditorId | null;
  onRename: (title: string) => Promise<void>;
  onTogglePanel: (tab: PanelTab) => void;
  onOpenEditor: (editor: EditorId) => void;
  onLoadEditors: () => void;
}

/** Title (click to rename), project, run-state pill; right: open-in-editor, changes, terminal, commit. */
export const ChatHeader = memo(function ChatHeader({
  thread,
  project,
  panel,
  editors,
  defaultEditor,
  onRename,
  onTogglePanel,
  onOpenEditor,
  onLoadEditors,
}: ChatHeaderProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(thread.title);
  const committing = useRef(false);

  useEffect(() => {
    if (!editing) setDraft(thread.title);
  }, [thread.title, editing]);

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
            onClick={() => {
              committing.current = true;
              setEditing(true);
            }}
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
      <div className="hc-toolbar no-drag" role="toolbar" aria-label="스레드 도구">
        <EditorMenu editors={editors} defaultEditor={defaultEditor} onOpen={onOpenEditor} onLoad={onLoadEditors} />
        <button
          type="button"
          className={`hc-toolbar-btn hc-toolbar-btn--icon${panel === 'changes' ? ' hc-toolbar-btn--on' : ''}`}
          aria-label="변경사항 패널"
          aria-pressed={panel === 'changes'}
          title="변경사항 (⌘⇧D)"
          onClick={() => onTogglePanel('changes')}
        >
          <GlyphChanges />
        </button>
        <button
          type="button"
          className={`hc-toolbar-btn hc-toolbar-btn--icon${panel === 'terminal' ? ' hc-toolbar-btn--on' : ''}`}
          aria-label="터미널 패널"
          aria-pressed={panel === 'terminal'}
          title="터미널 (⌘J)"
          onClick={() => onTogglePanel('terminal')}
        >
          <GlyphTerminal />
        </button>
        <CommitMenu thread={thread} />
      </div>
    </div>
  );
});
