import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { Thread } from '../../../shared/types';
import { DRAFT_PTY_SESSION_ID } from '../../../shared/constants';
import { on } from '../../api';
import { useAppStore, selectPtyStatus, type PanelTab, PANEL_MAX_WIDTH, PANEL_MIN_WIDTH } from '../../store';
import { Button, Segmented } from '../common';
import { GlyphChanges, GlyphClose, GlyphTerminal } from '../common/glyphs';
import { ChangesPanel } from '../Changes/ChangesPanel';
import { TerminalPane } from '../Terminal/TerminalPane';
import { resetTerminalEntry } from '../Terminal/terminalRegistry';
import './Shell.css';

export interface RightPanelProps {
  tab: PanelTab | null;
  /** Thread shown in the chat pane (null: draft / no thread -- the terminal tab still works, via the draft
   *  session). */
  thread: Thread | null;
  /** pty session id the terminal tab attaches to: the open thread's id, or `DRAFT_PTY_SESSION_ID` when no
   *  thread is open yet. */
  terminalSessionId: string;
  /** Project the draft terminal's shell should run in (ignored once `thread` is set -- its own cwd is used). */
  draftProjectId: string | null;
  width: number;
  onTab: (tab: PanelTab) => void;
  onClose: () => void;
  onResize: (width: number) => void;
  /** Drag in progress (the grid transition is paused while resizing). */
  onResizing: (resizing: boolean) => void;
}

/**
 * Right panel (변경사항 / 터미널 tabs). Slides open with the grid column; the left edge is a drag handle
 * (also arrow keys when focused) whose width persists per viewer.
 */
export function RightPanel({
  tab,
  thread,
  terminalSessionId,
  draftProjectId,
  width,
  onTab,
  onClose,
  onResize,
  onResizing,
}: RightPanelProps) {
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);
  // The last tab stays rendered while the panel slides closed.
  const [shownTab, setShownTab] = useState<PanelTab>(tab ?? 'changes');
  useEffect(() => {
    if (tab) setShownTab(tab);
  }, [tab]);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { startX: e.clientX, startWidth: width };
    onResizing(true);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    onResize(drag.current.startWidth + (drag.current.startX - e.clientX));
  };
  const endDrag = () => {
    if (!drag.current) return;
    drag.current = null;
    onResizing(false);
  };

  return (
    <div className="hc-panel" aria-hidden={!tab} inert={!tab}>
      <div
        className="hc-panel__handle"
        role="separator"
        aria-orientation="vertical"
        aria-label="패널 너비 조절"
        aria-valuemin={PANEL_MIN_WIDTH}
        aria-valuemax={PANEL_MAX_WIDTH}
        aria-valuenow={width}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={() => onResize(460)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') onResize(width + 24);
          if (e.key === 'ArrowRight') onResize(width - 24);
        }}
      />
      <div className="hc-panel__header drag-region">
        <Segmented<PanelTab>
          aria-label="패널"
          size="sm"
          className="no-drag"
          value={shownTab}
          options={[
            { value: 'changes', label: <><GlyphChanges width={13} height={13} />변경사항</> },
            { value: 'terminal', label: <><GlyphTerminal width={13} height={13} />터미널</> },
          ]}
          onChange={onTab}
        />
        <Button variant="plain" size="sm" icon className="no-drag" aria-label="패널 닫기" title="패널 닫기" onClick={onClose}>
          <GlyphClose width={14} height={14} />
        </Button>
      </div>
      <div className="hc-panel__body">
        {shownTab === 'changes' ? (
          thread ? (
            <ChangesPanel key={thread.id} thread={thread} />
          ) : (
            <PanelEmpty text="스레드를 열면 작업 폴더의 변경 사항이 여기에 표시됩니다" />
          )
        ) : (
          <div className="hc-panel__terminal" data-testid="terminal">
            {tab === 'terminal' ? (
              <SessionTerminal sessionId={terminalSessionId} draftProjectId={thread ? null : draftProjectId} />
            ) : (
              <PanelEmpty text="터미널을 열면 여기에 셸이 표시됩니다" />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function PanelEmpty({ text }: { text: string }) {
  return <div className="hc-panel__empty">{text}</div>;
}

// ---------------------------------------------------------------------------
// Terminal tab: pty:open replay seeds the xterm once, pty:data (filtered by thread) streams live output.
// ---------------------------------------------------------------------------

const lastTerminalSize = new Map<string, { cols: number; rows: number }>();

/** Drops the remembered terminal size of a deleted thread. */
export function forgetTerminalSize(threadId: string): void {
  lastTerminalSize.delete(threadId);
}

const subscribeOutput = (sessionId: string, onChunk: (data: string) => void) =>
  on('pty:data', (payload) => {
    if (payload.threadId === sessionId) onChunk(payload.data);
  });

const getInitialContent = async (sessionId: string, projectId: string | undefined) => {
  const size = lastTerminalSize.get(sessionId) ?? { cols: 80, rows: 24 };
  const { replay } = await useAppStore.getState().openTerminal(sessionId, size.cols, size.rows, projectId);
  return replay;
};

/**
 * Terminal tab content for one pty session: a real thread's, or the draft's (`DRAFT_PTY_SESSION_ID`) before any
 * thread exists. For the draft session, changing `draftProjectId` (the folder chip) reopens the shell in the
 * new folder -- main kills the old one and spawns a fresh one there (ptyManager.open, cwd mismatch).
 */
function SessionTerminal({ sessionId, draftProjectId }: { sessionId: string; draftProjectId: string | null }) {
  const pty = useAppStore((s) => selectPtyStatus(s, sessionId));
  // Bumped by Restart, or a draft folder change: remounts TerminalPane, which re-seeds the (reset) entry
  // from a fresh `pty:open`.
  const [generation, setGeneration] = useState(0);
  const exited = pty !== undefined && !pty.running;
  const isDraft = sessionId === DRAFT_PTY_SESSION_ID;
  const prevDraftProjectId = useRef(draftProjectId);

  useEffect(() => {
    if (!isDraft || prevDraftProjectId.current === draftProjectId) return;
    prevDraftProjectId.current = draftProjectId;
    // The old shell's exit never reaches pty:exit (main replaces it synchronously): reset the entry
    // ourselves so the remount below re-seeds from the freshly reopened session instead of reusing content
    // seeded from the old folder.
    resetTerminalEntry(sessionId);
    setGeneration((g) => g + 1);
  }, [isDraft, sessionId, draftProjectId]);

  const onResize = useCallback(
    (cols: number, rows: number) => {
      lastTerminalSize.set(sessionId, { cols, rows });
      void useAppStore.getState().resizeTerminal(sessionId, cols, rows);
    },
    [sessionId],
  );
  // Stable across unrelated re-renders (TerminalPane re-attaches whenever this reference changes) -- only
  // the draft session's projectId ever legitimately changes it.
  const draftProjectIdForOpen = isDraft ? (draftProjectId ?? undefined) : undefined;
  const onGetInitialContent = useCallback(
    (id: string) => getInitialContent(id, draftProjectIdForOpen),
    [draftProjectIdForOpen],
  );
  return (
    <div className="app__terminal-host">
      <TerminalPane
        key={generation}
        sessionId={sessionId}
        onData={(data) => {
          if (!exited) void useAppStore.getState().writeTerminal(sessionId, data);
        }}
        subscribeOutput={subscribeOutput}
        getInitialContent={onGetInitialContent}
        onResize={onResize}
      />
      {exited ? (
        <div className="app__terminal-exited" role="status">
          <span>셸이 종료되었습니다{pty.lastExitCode ? ` (코드 ${pty.lastExitCode})` : ''}</span>
          <span aria-hidden>·</span>
          <Button variant="secondary" size="sm" onClick={() => setGeneration((g) => g + 1)}>
            다시 시작
          </Button>
        </div>
      ) : null}
    </div>
  );
}
