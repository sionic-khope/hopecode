import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { DRAFT_PTY_SESSION_ID } from '../../../shared/constants';
import { tildePath } from '../../../core/format';
import { on } from '../../api';
import { useAppStore, selectPtyStatus, TERMINAL_MIN_HEIGHT } from '../../store';
import { Button } from '../common';
import { GlyphClose, GlyphRefresh, GlyphTerminal } from '../common/glyphs';
import { TerminalPane } from '../Terminal/TerminalPane';
import { getTerminalEntry, resetTerminalEntry } from '../Terminal/terminalRegistry';
import './Shell.css';

/** Double-click on the top edge restores this height. */
const DEFAULT_HEIGHT = 280;
/** Keeps the shell mounted while the panel slides closed (a little longer than `--motion-3`). */
const UNMOUNT_DELAY_MS = 360;

export interface BottomPanelProps {
  open: boolean;
  /** pty session: the open thread's id, or `DRAFT_PTY_SESSION_ID` before any thread exists. */
  sessionId: string;
  /** Project the draft shell runs in (null for a real thread -- its own cwd is used). */
  draftProjectId: string | null;
  /** Absolute folder the shell runs in, shown `~`-abbreviated in the header. */
  cwd: string | null;
  homeDir: string | null;
  height: number;
  onResize: (height: number) => void;
  /** Drag in progress (the height transition is paused while resizing). */
  onResizing: (resizing: boolean) => void;
  onClose: () => void;
}

/**
 * Terminal docked under the conversation (⌘J), inside the chat column. Slides open by animating its height;
 * the top edge is a drag handle (also ↑/↓ when focused) whose height persists per viewer.
 */
export function BottomPanel({ open, sessionId, draftProjectId, cwd, homeDir, height, onResize, onResizing, onClose }: BottomPanelProps) {
  const drag = useRef<{ startY: number; startHeight: number } | null>(null);
  // Mounted while open and during the closing slide, so the shell's last frame stays visible as it collapses.
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      return undefined;
    }
    const id = window.setTimeout(() => setMounted(false), UNMOUNT_DELAY_MS);
    return () => window.clearTimeout(id);
  }, [open]);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { startY: e.clientY, startHeight: height };
    onResizing(true);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    onResize(drag.current.startHeight + (drag.current.startY - e.clientY));
  };
  const endDrag = () => {
    if (!drag.current) return;
    drag.current = null;
    onResizing(false);
  };

  const session = useSessionTerminal(sessionId, draftProjectId);
  const shownCwd = cwd ? tildePath(cwd, homeDir) : null;

  return (
    <section
      className={`hc-bottom${open ? ' hc-bottom--open' : ''}`}
      aria-label="하단 터미널"
      aria-hidden={!open}
      inert={!open}
      data-testid="bottom-panel"
      style={{ ['--hc-bottom-h' as string]: `${height}px` }}
    >
      <div className="hc-bottom__inner">
        <div
          className="hc-bottom__handle"
          role="separator"
          aria-orientation="horizontal"
          aria-label="터미널 높이 조절"
          aria-valuemin={TERMINAL_MIN_HEIGHT}
          aria-valuenow={height}
          tabIndex={0}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onDoubleClick={() => onResize(DEFAULT_HEIGHT)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowUp') onResize(height + 24);
            if (e.key === 'ArrowDown') onResize(height - 24);
          }}
        />
        <header className="hc-bottom__header">
          <span className="hc-bottom__title">
            <GlyphTerminal width={13} height={13} aria-hidden />
            터미널
          </span>
          {shownCwd ? (
            <span className="hc-bottom__cwd" title={cwd ?? undefined} data-testid="terminal-cwd">
              {shownCwd}
            </span>
          ) : null}
          <span className="hc-bottom__spacer" />
          <Button variant="plain" size="sm" icon aria-label="터미널 재시작" title="터미널 재시작" onClick={session.restart}>
            <GlyphRefresh width={13} height={13} />
          </Button>
          <Button variant="plain" size="sm" icon aria-label="터미널 닫기" title="터미널 닫기 (⌘J)" onClick={onClose}>
            <GlyphClose width={13} height={13} />
          </Button>
        </header>
        <div className="hc-bottom__body" data-testid="terminal">
          {mounted ? <SessionTerminal sessionId={sessionId} session={session} /> : null}
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Session terminal: pty:open replay seeds the xterm once, pty:data (filtered by session) streams live output.
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

interface SessionTerminalState {
  /** Bumped by a restart after exit, or a draft folder change: remounts TerminalPane, which re-seeds the
   *  (reset) entry from a fresh `pty:open`. */
  generation: number;
  exited: boolean;
  lastExitCode: number | null;
  /** Project id sent with `pty:open` / `pty:restart` (draft session only). */
  draftProjectIdForOpen: string | undefined;
  /** Header 재시작 / overlay 다시 시작: a fresh shell in the same folder. */
  restart: () => void;
}

/**
 * State shared by the header's restart button and the terminal body. For the draft session, changing
 * `draftProjectId` (the folder chip) reopens the shell in the new folder -- main kills the old one and spawns
 * a fresh one there (ptyManager.open, cwd mismatch).
 */
function useSessionTerminal(sessionId: string, draftProjectId: string | null): SessionTerminalState {
  const pty = useAppStore((s) => selectPtyStatus(s, sessionId));
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

  const draftProjectIdForOpen = isDraft ? (draftProjectId ?? undefined) : undefined;

  const restart = useCallback(() => {
    const entry = getTerminalEntry(sessionId);
    if (exited || !entry?.ready) {
      // No live shell (it exited, or was never opened): the remount opens a new one via pty:open.
      resetTerminalEntry(sessionId);
      setGeneration((g) => g + 1);
      return;
    }
    // Live shell: keep the entry and its output subscription, clear the screen, and swap the shell in main.
    entry.terminal.reset();
    const size = lastTerminalSize.get(sessionId) ?? { cols: entry.terminal.cols, rows: entry.terminal.rows };
    void useAppStore
      .getState()
      .restartTerminal(sessionId, size.cols, size.rows, draftProjectIdForOpen)
      .then(() => entry.terminal.focus())
      .catch((err: unknown) => console.error('[hopecode] terminal restart failed', err));
  }, [sessionId, exited, draftProjectIdForOpen]);

  return { generation, exited, lastExitCode: pty?.lastExitCode ?? null, draftProjectIdForOpen, restart };
}

function SessionTerminal({ sessionId, session }: { sessionId: string; session: SessionTerminalState }) {
  const { generation, exited, lastExitCode, draftProjectIdForOpen, restart } = session;
  const onResize = useCallback(
    (cols: number, rows: number) => {
      lastTerminalSize.set(sessionId, { cols, rows });
      void useAppStore.getState().resizeTerminal(sessionId, cols, rows);
    },
    [sessionId],
  );
  // Stable across unrelated re-renders (TerminalPane re-attaches whenever this reference changes) -- only
  // the draft session's projectId ever legitimately changes it.
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
          <span>셸이 종료되었습니다{lastExitCode ? ` (코드 ${lastExitCode})` : ''}</span>
          <span aria-hidden>·</span>
          <Button variant="secondary" size="sm" onClick={restart}>
            다시 시작
          </Button>
        </div>
      ) : null}
    </div>
  );
}
