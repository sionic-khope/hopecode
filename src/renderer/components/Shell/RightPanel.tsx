import { useRef, type PointerEvent as ReactPointerEvent } from 'react';
import type { Thread } from '../../../shared/types';
import { type PanelTab, PANEL_MAX_WIDTH, PANEL_MIN_WIDTH } from '../../store';
import { Button } from '../common';
import { GlyphChanges, GlyphClose } from '../common/glyphs';
import { ChangesPanel } from '../Changes/ChangesPanel';
import './Shell.css';

export interface RightPanelProps {
  tab: PanelTab | null;
  /** Thread shown in the chat pane (null: draft / no thread -- the panel shows a hint). */
  thread: Thread | null;
  width: number;
  onClose: () => void;
  onResize: (width: number) => void;
  /** Drag in progress (the grid transition is paused while resizing). */
  onResizing: (resizing: boolean) => void;
}

/**
 * Right panel: 변경사항 (the terminal docks under the conversation instead, see BottomPanel). Slides open with
 * the grid column; the left edge is a drag handle (also arrow keys when focused) whose width persists per viewer.
 */
export function RightPanel({ tab, thread, width, onClose, onResize, onResizing }: RightPanelProps) {
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);

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
        <h2 className="hc-panel__title">
          <GlyphChanges width={14} height={14} aria-hidden />
          변경사항
        </h2>
        <Button variant="plain" size="sm" icon className="no-drag" aria-label="변경사항 패널 닫기" title="변경사항 패널 닫기 (⌘⇧D)" onClick={onClose}>
          <GlyphClose width={14} height={14} />
        </Button>
      </div>
      <div className="hc-panel__body">
        {thread ? (
          <ChangesPanel key={thread.id} thread={thread} />
        ) : (
          <PanelEmpty text="스레드를 열면 작업 폴더의 변경 사항이 여기에 표시됩니다" />
        )}
      </div>
    </div>
  );
}

function PanelEmpty({ text }: { text: string }) {
  return <div className="hc-panel__empty">{text}</div>;
}
