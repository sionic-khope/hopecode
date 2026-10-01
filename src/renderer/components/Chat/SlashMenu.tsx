import { useEffect, useMemo, useRef, useState, type AnchorHTMLAttributes, type RefObject } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Popover } from '../common';
import { displayPath } from '../../../core/displayPath';
import { invoke } from '../../api';
import type { AcpCommandLite } from '../../../shared/types';
import { fromAcp, fromClaude, type SlashItem } from './slashCommands';

export interface SlashMenuProps {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  /** id of the listbox (the textarea's aria-controls). */
  listId: string;
  items: readonly SlashItem[];
  activeIndex: number;
  onActiveChange: (index: number) => void;
  onChoose: (index: number) => void;
  /** Shown instead of rows (agent session not started, list loading). */
  emptyHint?: string | null;
  width?: number;
  homeDir?: string | null;
}

export const slashOptionId = (listId: string, index: number) => `${listId}-opt-${index}`;

// Preview body is the skill file's own text: rendered as markdown without raw HTML, links stay inert text and
// images are never fetched.
function InertLink({ node: _node, href: _href, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { node?: unknown }) {
  return <span className="hc-slash__link" {...props} />;
}
const PREVIEW_COMPONENTS: Components = { a: InertLink };
const PREVIEW_PLUGINS = [remarkGfm];
const DISALLOWED = ['img'];

/** Composer `/` picker: command rows (heart on the active one) beside a preview of the active command. */
export function SlashMenu({
  open,
  onClose,
  anchorRef,
  listId,
  items,
  activeIndex,
  onActiveChange,
  onChoose,
  emptyHint,
  width = 640,
  homeDir = null,
}: SlashMenuProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const active = items[activeIndex] ?? null;

  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`#${CSS.escape(slashOptionId(listId, activeIndex))}`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex, listId]);

  return (
    <Popover open={open} onClose={onClose} anchorRef={anchorRef} placement="top-start" width={width} offset={10} className="hc-slash" aria-label="명령">
      {items.length === 0 ? (
        <div className="hc-slash__empty" role="status" data-testid="slash-empty">
          {emptyHint}
        </div>
      ) : (
        <div className="hc-slash__body" data-testid="slash-menu">
          <div ref={listRef} id={listId} className="hc-slash__list" role="listbox" aria-label="명령">
            {items.map((item, i) => (
              <div
                key={item.name}
                id={slashOptionId(listId, i)}
                role="option"
                aria-selected={i === activeIndex}
                className={`hc-slash__item${i === activeIndex ? ' hc-slash__item--active' : ''}`}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => onActiveChange(i)}
                onClick={() => onChoose(i)}
              >
                <span className="hc-slash__row">
                  <span className="hc-slash__name">/{item.label}</span>
                  <span className={`hc-slash__badge hc-slash__badge--${item.source}`}>{item.badge}</span>
                </span>
                {item.description ? <span className="hc-slash__desc">{item.description}</span> : null}
              </div>
            ))}
          </div>
          {active ? (
            <div className="hc-slash__preview" data-testid="slash-preview" aria-live="polite">
              <div className="hc-slash__ptitle">
                /{active.label}
                {active.argumentHint ? <span className="hc-slash__hint"> {active.argumentHint}</span> : null}
              </div>
              {active.description ? <p className="hc-slash__pdesc">{active.description}</p> : null}
              <dl className="hc-slash__meta">
                <dt>출처</dt>
                <dd>{active.badge}</dd>
                {active.argumentHint ? (
                  <>
                    <dt>인자</dt>
                    <dd>{active.argumentHint}</dd>
                  </>
                ) : null}
                {active.path ? (
                  <>
                    <dt>파일</dt>
                    <dd className="hc-slash__path" title={active.path}>
                      {displayPath(active.path, null, homeDir)}
                    </dd>
                  </>
                ) : null}
              </dl>
              {active.preview ? (
                <div className="hc-slash__md hc-md">
                  <Markdown
                    remarkPlugins={PREVIEW_PLUGINS}
                    components={PREVIEW_COMPONENTS}
                    disallowedElements={DISALLOWED}
                    skipHtml
                  >
                    {active.preview}
                  </Markdown>
                </div>
              ) : (
                <p className="hc-slash__note">
                  {active.argumentHint ? '⇥ / ⏎로 고른 뒤 인자를 이어서 입력하세요.' : '⏎로 바로 보냅니다.'}
                </p>
              )}
            </div>
          ) : null}
        </div>
      )}
    </Popover>
  );
}

/** Where the composer's `/` picker gets its rows. */
export type SlashSource =
  /** Claude Code: `commands:list` (live session + ~/.claude scan); a draft passes its project. */
  | { kind: 'claude'; threadId?: string; projectId?: string | null }
  /** Codex / Hermes: the session's `available_commands_update` (undefined until the session sent one). */
  | { kind: 'acp'; agentName: string; commands: readonly AcpCommandLite[] | undefined };

export const ACP_COMMANDS_PENDING_HINT = '세션이 시작되면 명령이 표시됩니다';
const LOADING_HINT = '명령을 불러오는 중…';

/**
 * Rows for the picker. Claude lists are fetched each time the picker opens (`active` turns true), so a skill added
 * on disk shows up without a restart.
 */
export function useSlashItems(source: SlashSource | undefined, active: boolean): { items: SlashItem[]; emptyHint: string | null } {
  const [claude, setClaude] = useState<{ key: string; items: SlashItem[] } | null>(null);
  const key = source?.kind === 'claude' ? `${source.threadId ?? ''}|${source.projectId ?? ''}` : null;

  useEffect(() => {
    if (!active || key === null || source?.kind !== 'claude') return;
    let cancelled = false;
    const req = source.threadId ? { threadId: source.threadId } : source.projectId ? { projectId: source.projectId } : {};
    invoke('commands:list', req)
      .then((list) => {
        if (!cancelled) setClaude({ key, items: fromClaude(list.commands) });
      })
      .catch((err: unknown) => {
        console.error('[hopecode] commands:list failed', err);
        if (!cancelled) setClaude({ key, items: [] });
      });
    return () => {
      cancelled = true;
    };
    // `key` covers the source fields that change the request.
  }, [active, key]);

  return useMemo(() => {
    if (!source) return { items: [], emptyHint: null };
    if (source.kind === 'acp') {
      return source.commands === undefined
        ? { items: [], emptyHint: ACP_COMMANDS_PENDING_HINT }
        : { items: fromAcp(source.commands, source.agentName), emptyHint: null };
    }
    if (!claude || claude.key !== key) return { items: [], emptyHint: LOADING_HINT };
    return { items: claude.items, emptyHint: null };
  }, [source, claude, key]);
}
