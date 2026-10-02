import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { displayPath } from '../../../core/displayPath';
import type { ToolItem } from '../../../shared/types';
import { Collapse } from '../common';
import { CheckCircleIcon, ChevronIcon, ErrorCircleIcon, SpinnerIcon, iconForTool } from './icons';
import { DiffView } from './DiffView';
import { MoreButton } from './MoreButton';
import { ToolImages } from '../Images/ChatImages';
import { imageCaption } from '../../../core/agentImages';
import { useTicker } from './TurnActivity';
import { formatElapsed } from './agentIssues';
import {
  formatDuration,
  groupStartsOpen,
  runningLine,
  summarizeToolGroup,
  summarizeToolInput,
  toolDurationMs,
  toolGroupLabel,
  toolState,
} from './toolGroups';
import './Chat.css';

export interface ToolCardProps {
  item: ToolItem;
  defaultExpanded?: boolean;
}

/** Thread folder + home, so tool summaries show `src/a.ts` / `~/x` instead of long absolute paths. */
export const ToolPathContext = createContext<{ cwd?: string | null; home?: string | null }>({});

/** The thread's turn is running: pending tool cards show "실행 중…" and their elapsed time (a pending card left over
 *  from an earlier, interrupted turn keeps only its spinner). */
export const TurnLiveContext = createContext(false);

/** Disclosure choices the user made this session, by `tool:<item id>` / `group:<first item id>` (survive thread
 *  switches and list re-mounts; a group and its first row share an item id, hence the prefixes). */
const rememberedOpen = new Map<string, boolean>();

/**
 * Open state of a disclosure keyed by item id: the user's last choice this session, else `fallback` (which may
 * change, e.g. a group opens itself when one of its calls fails, until the user picks a state).
 */
function useRememberedOpen(key: string, fallback: boolean): [boolean, () => void] {
  const [choice, setChoice] = useState<boolean | undefined>(() => rememberedOpen.get(key));
  const open = choice ?? fallback;
  const toggle = useCallback(() => {
    rememberedOpen.set(key, !open);
    setChoice(!open);
  }, [key, open]);
  return [open, toggle];
}

/** Click sound of a disclosure: opening selects, closing goes back (read by the capture-phase sound delegate). */
const sfxFor = (open: boolean) => (open ? 'back' : 'select');

/** The check pops in only when this view watched the call finish (not for finished calls loaded from history). */
function useSettled(running: boolean): boolean {
  const sawRunning = useRef(running);
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (running) sawRunning.current = true;
    else if (sawRunning.current) setSettled(true);
  }, [running]);
  return settled;
}

/** Lines of tool output shown before "N줄 더 보기" (and a character cap, for one huge line). */
export const OUTPUT_PREVIEW_LINES = 16;
const OUTPUT_PREVIEW_CHARS = 2400;

/** Shortened view of a long output: its first lines, or null when it is short enough to show whole. */
function outputPreview(text: string): { head: string; rest: number } | null {
  const lines = text.split('\n');
  if (lines.length <= OUTPUT_PREVIEW_LINES + 4 && text.length <= OUTPUT_PREVIEW_CHARS * 1.5) return null;
  let head = lines.slice(0, OUTPUT_PREVIEW_LINES).join('\n');
  if (head.length > OUTPUT_PREVIEW_CHARS) head = `${head.slice(0, OUTPUT_PREVIEW_CHARS)}…`;
  const shownLines = head.split('\n').length;
  return { head, rest: Math.max(1, lines.length - shownLines) };
}

/** A tool's text output: mono, wrapped, the first lines of a long one with "N줄 더 보기" / "접기". */
function ToolOutputText({ text, error }: { text: string; error: boolean }) {
  const [all, setAll] = useState(false);
  const preview = useMemo(() => outputPreview(text), [text]);
  const cls = `hc-tool__result${error ? ' hc-tool__result--error' : ''}`;
  if (!preview) return <pre className={cls}>{text}</pre>;
  return (
    <>
      <pre className={`${cls}${all ? '' : ' hc-tool__result--clipped'}`}>{all ? text : preview.head}</pre>
      <MoreButton count={all ? null : preview.rest} onClick={() => setAll(!all)} className="hc-tool__more" />
    </>
  );
}

function StatusIcon({ state }: { state: 'running' | 'error' | 'done' }) {
  if (state === 'running') return <SpinnerIcon width={13} height={13} />;
  if (state === 'error') return <ErrorCircleIcon width={13} height={13} />;
  return <CheckCircleIcon width={13} height={13} />;
}

/** Collapsible card for one tool_use / tool_result pair that needs its own surface (diff, permission, images). */
export const ToolCard = memo(function ToolCard({ item, defaultExpanded = false }: ToolCardProps) {
  const [open, toggle] = useRememberedOpen(`tool:${item.id}`, defaultExpanded);
  const Icon = iconForTool(item.name);
  const running = item.result === undefined;
  const hasError = item.isError === true;
  const live = useContext(TurnLiveContext) && running;
  const now = useTicker(live);
  const settled = useSettled(running);
  const paths = useContext(ToolPathContext);
  const summary = summarizeToolInput(item, paths.cwd, paths.home);
  const hasPatch = Array.isArray(item.patch) && item.patch.length > 0;
  const diffs = item.diffs ?? [];
  const editFallback =
    !hasPatch && diffs.length === 0 && item.name === 'Edit' && typeof item.input.old_string === 'string' && typeof item.input.new_string === 'string';
  // A Write of a new file carries no patch: its content shows as added lines.
  const writeFallback = !hasPatch && diffs.length === 0 && item.name === 'Write' && typeof item.input.content === 'string';

  return (
    <div
      className={`hc-tool${open ? ' hc-tool--open' : ''}${live ? ' hc-tool--running' : ''}`}
      data-tool-id={item.toolUseId}
      data-state={toolState(item)}
    >
      <button type="button" className="hc-tool__header" aria-expanded={open} data-sfx={sfxFor(open)} onClick={toggle}>
        <span className="hc-tool__icon">
          <Icon width={14} height={14} />
        </span>
        <span className="hc-tool__name">{item.name}</span>
        <span className="hc-tool__summary">{summary}</span>
        <span
          className={`hc-tool__status ${running ? 'hc-tool__status--running' : hasError ? 'hc-tool__status--error' : 'hc-tool__status--ok'}${settled ? ' hc-tool__status--settled' : ''}`}
          role={live ? 'status' : undefined}
        >
          {live ? (
            <span className="hc-tool__progress">
              실행 중…<span className="hc-tool__elapsed" aria-hidden>{formatElapsed(now - item.createdAt)}</span>
            </span>
          ) : null}
          <StatusIcon state={toolState(item)} />
        </span>
        <span className="hc-tool__chevron">
          <ChevronIcon width={13} height={13} />
        </span>
      </button>
      <Collapse open={open}>
        <div className="hc-tool__body">
          {hasPatch ? <DiffView patch={item.patch} /> : null}
          {diffs.map((d, i) => (
            <div key={`${d.path}:${i}`} className="hc-tool__file-diff" data-testid="tool-file-diff">
              <div className="hc-tool__file-path" title={d.path}>
                {displayPath(d.path, paths.cwd, paths.home)}
                {d.oldText === '' ? <span className="hc-tool__file-tag">새 파일</span> : null}
                {d.truncated ? <span className="hc-tool__file-tag">일부만 표시</span> : null}
              </div>
              <DiffView oldText={d.oldText} newText={d.newText} />
            </div>
          ))}
          {editFallback ? (
            <DiffView oldText={item.input.old_string as string} newText={item.input.new_string as string} />
          ) : null}
          {writeFallback ? <DiffView oldText="" newText={item.input.content as string} /> : null}
          {item.result !== undefined ? <ToolOutputText text={item.result} error={hasError} /> : null}
        </div>
      </Collapse>
      {item.images && item.images.length > 0 ? (
        <div className="hc-tool__images">
          <ToolImages
            images={item.images}
            path={typeof item.input.file_path === 'string' ? item.input.file_path : undefined}
            caption={imageCaption(item)}
          />
        </div>
      ) : null}
    </div>
  );
});

/**
 * One quiet call as a frameless line: icon, name, input (mono, ellipsized), status and time on the right. The line
 * is a button; its output opens under it behind a thin rule. A failed call starts open.
 */
export const ToolRow = memo(function ToolRow({ item }: { item: ToolItem }) {
  const state = toolState(item);
  const [open, toggle] = useRememberedOpen(`tool:${item.id}`, state === 'error');
  const Icon = iconForTool(item.name);
  const running = state === 'running';
  const live = useContext(TurnLiveContext) && running;
  const now = useTicker(live);
  const settled = useSettled(running);
  const paths = useContext(ToolPathContext);
  const summary = summarizeToolInput(item, paths.cwd, paths.home);
  const duration = toolDurationMs(item);

  return (
    <div
      className={`hc-tool hc-tool--row${open ? ' hc-tool--open' : ''}${live ? ' hc-tool--running' : ''}`}
      data-tool-id={item.toolUseId}
      data-state={state}
    >
      <button
        type="button"
        className="hc-tool__header hc-soul"
        aria-expanded={open}
        data-sfx={sfxFor(open)}
        onClick={toggle}
        title={summary || item.name}
      >
        <span className="hc-tool__icon">
          <Icon width={13} height={13} />
        </span>
        <span className="hc-tool__name">{item.name}</span>
        <span className="hc-tool__summary">{summary}</span>
        <span
          className={`hc-tool__status hc-tool__status--${running ? 'running' : state === 'error' ? 'error' : 'ok'}${settled ? ' hc-tool__status--settled' : ''}`}
          role={live ? 'status' : undefined}
        >
          {live ? (
            <span className="hc-tool__progress">
              실행 중…<span className="hc-tool__elapsed" aria-hidden>{formatElapsed(now - item.createdAt)}</span>
            </span>
          ) : null}
          {duration !== null ? <span className="hc-tool__duration">{formatDuration(duration)}</span> : null}
          <StatusIcon state={state} />
        </span>
      </button>
      <Collapse open={open}>
        <div className="hc-tool__output" data-testid="tool-output">
          {item.result !== undefined ? (
            <ToolOutputText text={item.result.trim() === '' ? '(출력 없음)' : item.result} error={state === 'error'} />
          ) : (
            <p className="hc-tool__waiting">{live ? '실행 중…' : '결과를 받지 못했습니다.'}</p>
          )}
        </div>
      </Collapse>
    </div>
  );
});

/**
 * Consecutive quiet calls folded into one frameless summary line ("▸ 명령 8개 실행 · 12s ✓"). While a call runs the
 * line shows it live; a failure opens the group and adds a red "실패 n". Expanded, every call is a ToolRow.
 */
export const ToolGroup = memo(function ToolGroup({ id, tools }: { id: string; tools: ToolItem[] }) {
  const summary = summarizeToolGroup(tools);
  const [open, toggle] = useRememberedOpen(`group:${id}`, groupStartsOpen(tools));
  const turnLive = useContext(TurnLiveContext);
  const live = turnLive && summary.running !== null;
  const now = useTicker(live);
  const settled = useSettled(summary.running !== null);
  const paths = useContext(ToolPathContext);
  const label = toolGroupLabel(summary);
  const current = summary.running ? runningLine(summary.running, paths.cwd, paths.home) : null;

  return (
    <div
      className={`hc-toolgroup${open ? ' hc-toolgroup--open' : ''}`}
      data-testid="tool-group"
      data-state={summary.state}
      data-count={summary.total}
    >
      <button
        type="button"
        className="hc-toolgroup__summary hc-soul"
        aria-expanded={open}
        data-sfx={sfxFor(open)}
        onClick={toggle}
      >
        <span className="hc-toolgroup__chevron" aria-hidden>
          <ChevronIcon width={12} height={12} />
        </span>
        <span className="hc-toolgroup__label" data-testid="tool-group-label">
          {label}
        </span>
        {summary.failed > 0 ? (
          <span className="hc-toolgroup__failed" data-testid="tool-group-failed">
            실패 {summary.failed}
          </span>
        ) : null}
        {current !== null ? (
          <span className="hc-toolgroup__current" data-testid="tool-group-current" title={current}>
            {current}
          </span>
        ) : null}
        <span
          className={`hc-toolgroup__status hc-tool__status--${summary.state === 'running' ? 'running' : summary.state === 'error' ? 'error' : 'ok'}${settled ? ' hc-tool__status--settled' : ''}`}
          role={live ? 'status' : undefined}
        >
          {live && summary.running ? (
            <span className="hc-toolgroup__time" aria-hidden>
              {formatElapsed(now - summary.running.createdAt)}
            </span>
          ) : summary.durationMs !== null ? (
            <span className="hc-toolgroup__time">{formatDuration(summary.durationMs)}</span>
          ) : null}
          <StatusIcon state={summary.state} />
        </span>
      </button>
      <Collapse open={open}>
        <div className="hc-toolgroup__rows">
          {tools.map((t) => (
            <ToolRow key={t.id} item={t} />
          ))}
        </div>
      </Collapse>
    </div>
  );
});
