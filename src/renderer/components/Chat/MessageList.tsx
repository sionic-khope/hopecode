import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AgentKind, AssistantTextItem, ChatItem, PermissionDecision, PermissionRequest } from '../../../shared/types';
import type { TurnPhase } from '../../store';
import { AGENTS } from '../../../shared/agents';
import { AgentIcon } from '../Agent/AgentIcon';
import { GlyphEditResend } from '../common/glyphs';
import { AssistantText } from './AssistantText';
import { CopyButton } from './CopyButton';
import { MarkdownCopyChip } from './MarkdownCopyChip';
import { ToolCard, ToolGroup, ToolRow } from './ToolCard';
import { PermissionCard } from './PermissionCard';
import { SystemNotice } from './SystemNotice';
import { AgentWarningNotice, ErrorCard, type ErrorCardActions } from './ErrorCard';
import { TurnActivity } from './TurnActivity';
import { splitAgentWarning } from './agentIssues';
import { buildTranscript, type TurnSegment } from './toolGroups';
import { buildChatTree, findSubagentNode, type ChatNode, type SubagentSummary } from '../../../core/subagents';
import { SubagentCard, SubagentNavContext, SubagentRouting } from '../Subagents/SubagentCard';
import { SubagentDetail } from '../Subagents/SubagentDetail';
import { ImageGalleryCard, ThreadImageContext, ToolImages, UserImages } from '../Images/ChatImages';
import { UserFiles } from '../Images/ComposerAttachments';
import './Chat.css';

export interface MessageListProps {
  items: ChatItem[];
  /** Item id currently receiving text-delta events (renders the blinking cursor). */
  streamingItemId?: string | null;
  permissionRequests: PermissionRequest[];
  onPermissionDecision: (requestId: string, decision: PermissionDecision) => void;
  emptyLabel?: string;
  /** Reports whether the list is scrolled away from its top (title bar divider). */
  onScrolledChange?: (scrolled: boolean) => void;
  /** Agent of the thread (avatar next to its messages). */
  agent?: AgentKind;
  /** "편집해서 다시 보내기": put a user message back into the composer. */
  onEditResend?: (text: string) => void;
  /** Thread whose folder gallery / tool image paths resolve against (image:read). */
  threadId?: string;
  /** Running turn with nothing streaming: the "생각 중" row in the agent's slot. */
  activity?: TurnPhase | null;
  /** Buttons of the error card that ended the latest turn (older error cards show none). */
  errorActions?: ErrorCardActions | null;
}

const NEAR_BOTTOM_PX = 96;

/** Id of the error notice that ended the latest turn: no user message after it. */
function latestErrorId(items: readonly ChatItem[]): string | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.type === 'user') return null;
    if (it.type === 'notice' && it.level === 'error') return it.id;
  }
  return null;
}

/** Subagent node -> the turn's top-level subagents, keyed by the first subagent node id of each turn. */
function routingByTurn(nodes: readonly ChatNode[]): Map<string, SubagentSummary[]> {
  const out = new Map<string, SubagentSummary[]>();
  let first: string | null = null;
  for (const node of nodes) {
    if (node.item.type === 'user') {
      first = null;
      continue;
    }
    if (node.kind !== 'subagent') continue;
    if (first === null) {
      first = node.item.id;
      out.set(first, []);
    }
    out.get(first)!.push(node.summary);
  }
  return out;
}

/** Images an agent sent as message content (ACP image blocks). */
function AgentImages({ images }: { images: NonNullable<Extract<ChatItem, { type: 'assistant-text' }>['images']> }) {
  return (
    <div className="hc-say-images">
      <ToolImages images={images} label="에이전트 이미지" />
    </div>
  );
}

/** Item nested in a subagent card / the subagent view (no avatar gutter). */
function renderSubagentChild(node: ChatNode): ReactNode {
  if (node.kind === 'subagent') return <SubagentCard node={node} renderChild={renderSubagentChild} />;
  const item = node.item;
  if (item.type === 'assistant-text') {
    return (
      <>
        {item.text ? <AssistantText text={item.text} streaming={false} /> : null}
        {item.images && item.images.length > 0 ? <AgentImages images={item.images} /> : null}
      </>
    );
  }
  if (item.type === 'tool') return <ToolRow item={item} />;
  return null;
}

/** Ordered chat transcript: user bubbles, streaming assistant text, tool cards, notices, permission cards. */
export function MessageList({
  items,
  streamingItemId = null,
  permissionRequests,
  onPermissionDecision,
  emptyLabel = '아직 메시지가 없습니다',
  onScrolledChange,
  agent = 'claude-code',
  onEditResend,
  threadId,
  activity = null,
  errorActions = null,
}: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  // Subagent view (Codex style): the main area shows one subagent's transcript until "← 메인 대화" / Escape.
  const [subView, setSubView] = useState<{ threadId: string | undefined; toolUseId: string } | null>(null);
  const mainScrollTop = useRef(0);
  const openSubagent = useCallback(
    (toolUseId: string) => {
      const el = scrollRef.current;
      if (el && !subView) mainScrollTop.current = el.scrollTop;
      setSubView({ threadId, toolUseId });
    },
    [threadId, subView],
  );
  const closeSubagent = useCallback(() => setSubView(null), []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickToBottom.current) return;
    el.scrollTop = el.scrollHeight;
    onScrolledChange?.(el.scrollTop > 0);
  }, [items, streamingItemId, permissionRequests, onScrolledChange, activity]);

  useEffect(() => () => onScrolledChange?.(false), [onScrolledChange]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    onScrolledChange?.(el.scrollTop > 0);
  };

  const byToolUseId = useMemo(() => new Map(permissionRequests.map((r) => [r.toolUseId, r])), [permissionRequests]);
  // Subagent frames nest under their Task/Agent card; permission requests of nested calls stay in the bottom list.
  const nodes = useMemo(() => buildChatTree(items), [items]);
  const routing = useMemo(() => routingByTurn(nodes), [nodes]);
  // One block per agent turn (text and tool groups flow inside it) or per user message / notice.
  const blocks = useMemo(() => buildTranscript(nodes, new Set(byToolUseId.keys())), [nodes, byToolUseId]);
  const rendered = useMemo(() => {
    const ids = new Set<string>();
    for (const block of blocks) {
      if (block.kind !== 'turn') continue;
      for (const seg of block.segments) {
        const item = seg.kind === 'card' ? seg.item : seg.kind === 'node' ? seg.node.item : null;
        const request = item?.type === 'tool' ? byToolUseId.get(item.toolUseId) : undefined;
        if (request) ids.add(request.requestId);
      }
    }
    return ids;
  }, [blocks, byToolUseId]);
  // "생각하는 중…" continues the turn on screen instead of opening a second portrait.
  const activityInTurn = blocks[blocks.length - 1]?.kind === 'turn';
  const errorId = useMemo(() => (errorActions ? latestErrorId(items) : null), [errorActions, items]);
  const subNode = subView && subView.threadId === threadId ? findSubagentNode(nodes, subView.toolUseId) : null;
  const subKey = subNode?.item.toolUseId ?? null;

  // Entering a subagent view starts at its top; leaving it returns to where the main chat was.
  const prevSubKey = useRef<string | null>(null);
  useEffect(() => {
    const el = scrollRef.current;
    const was = prevSubKey.current;
    prevSubKey.current = subKey;
    if (!el || was === subKey) return;
    if (subKey) {
      stickToBottom.current = false;
      el.scrollTop = 0;
    } else {
      el.scrollTop = mainScrollTop.current;
      stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    }
  }, [subKey]);

  return (
    <ThreadImageContext.Provider value={threadId ?? null}>
    <SubagentNavContext.Provider value={openSubagent}>
    <div className="hc-messages" ref={scrollRef} onScroll={onScroll}>
      {subNode ? (
        <div className="hc-messages__inner">
          <SubagentDetail node={subNode} onBack={closeSubagent} renderChild={renderSubagentChild} />
          {/* Permission prompts stay answerable while a subagent is on screen. */}
          {permissionRequests.map((r) => (
            <PermissionCard key={r.requestId} request={r} onDecide={onPermissionDecision} />
          ))}
        </div>
      ) : items.length === 0 && permissionRequests.length === 0 && !activity ? (
        <div className="hc-messages__empty">{emptyLabel}</div>
      ) : (
        <div className="hc-messages__inner">
          {blocks.map((block, i) => {
            if (block.kind === 'turn') {
              return (
                <AgentTurn
                  key={block.id}
                  segments={block.segments}
                  agent={agent}
                  streamingItemId={streamingItemId}
                  pendingByToolUseId={byToolUseId}
                  onPermissionDecision={onPermissionDecision}
                  routing={routing}
                  activity={i === blocks.length - 1 ? activity : null}
                />
              );
            }
            const item = block.node.item;
            return (
              <MessageItem
                key={item.id}
                item={item}
                agent={agent}
                onEditResend={onEditResend}
                errorActions={item.id === errorId ? errorActions : null}
              />
            );
          })}
          {activity && !activityInTurn ? (
            <TurnActivity agent={agent} phase={activity.phase} startedAt={activity.startedAt} />
          ) : null}
          {permissionRequests
            .filter((r) => !rendered.has(r.requestId))
            .map((r) => (
              <div key={r.requestId} className="hc-agent-row hc-msg-enter">
                <span className="hc-agent-row__avatar" />
                <div className="hc-agent-row__body">
                  <PermissionCard request={r} onDecide={onPermissionDecision} />
                </div>
              </div>
            ))}
        </div>
      )}
    </div>
    </SubagentNavContext.Provider>
    </ThreadImageContext.Provider>
  );
}

/** Short speaker label on the first item of an agent run (CSS renders it as the "* CLAUDE" name tag). */
const AGENT_SHORT_NAME: Record<AgentKind, string> = { 'claude-code': 'Claude', codex: 'Codex', hermes: 'Hermes' };

function AgentNameTag({ agent }: { agent: AgentKind }) {
  return (
    <span className="hc-agent-name" data-agent={agent}>
      {AGENT_SHORT_NAME[agent]}
    </span>
  );
}

/** Text of an assistant item without a leading agent warning (the warning renders as its own notice). */
function answerOf(item: AssistantTextItem): { text: string; warning: ReturnType<typeof splitAgentWarning> } {
  const split = splitAgentWarning(item.text);
  return { text: split ? split.rest : item.text, warning: split };
}

/** One paragraph run of the turn: markdown, its images, and a model warning streamed ahead of it. */
const TurnText = memo(function TurnText({ item, streaming }: { item: AssistantTextItem; streaming: boolean }) {
  const { text, warning } = answerOf(item);
  return (
    <>
      {warning ? <AgentWarningNotice warning={warning.warning} /> : null}
      {text !== '' ? <AssistantText text={text} streaming={streaming} /> : null}
      {item.images && item.images.length > 0 ? <AgentImages images={item.images} /> : null}
    </>
  );
});

/**
 * One agent turn: the portrait and "* CLAUDE" tag once, then text, tool groups and the cards that need their own
 * surface (diffs, permission prompts, subagents, galleries) in order inside a single dialogue box.
 */
function AgentTurn({
  segments,
  agent,
  streamingItemId,
  pendingByToolUseId,
  onPermissionDecision,
  routing,
  activity,
}: {
  segments: TurnSegment[];
  agent: AgentKind;
  streamingItemId: string | null;
  pendingByToolUseId: ReadonlyMap<string, PermissionRequest>;
  onPermissionDecision: (requestId: string, decision: PermissionDecision) => void;
  routing: ReadonlyMap<string, SubagentSummary[]>;
  activity: TurnPhase | null;
}) {
  const streaming = segments.some((seg) => seg.kind === 'text' && seg.item.id === streamingItemId);
  const copyText = segments
    .flatMap((seg) => (seg.kind === 'text' ? [answerOf(seg.item).text.trim()] : []))
    .filter(Boolean)
    .join('\n\n');
  return (
    <div className="hc-agent-row hc-agent-row--lead hc-msg-enter hc-turn" data-testid="agent-turn">
      <span className="hc-agent-row__avatar">
        <span className="hc-agent-avatar" title={AGENTS[agent].name} aria-label={AGENTS[agent].name} role="img">
          <AgentIcon kind={agent} size={22} />
        </span>
      </span>
      <div className="hc-agent-row__body">
        {/* Dialogue box: white pixel frame, the speaker's name tag on its first line. */}
        <div className="hc-say hc-say--lead hc-turn__box">
          <AgentNameTag agent={agent} />
          {streaming || copyText === '' ? null : (
            <MarkdownCopyChip getText={() => copyText} label="응답을 마크다운으로 복사" className="hc-turn__copy" />
          )}
          {segments.map((seg) => {
            switch (seg.kind) {
              case 'text':
                return <TurnText key={seg.item.id} item={seg.item} streaming={seg.item.id === streamingItemId} />;
              case 'tools':
                return seg.tools.length === 1 ? (
                  <ToolRow key={seg.id} item={seg.tools[0]!} />
                ) : (
                  <ToolGroup key={seg.id} id={seg.id} tools={seg.tools} />
                );
              case 'card': {
                const request = pendingByToolUseId.get(seg.item.toolUseId);
                return (
                  <div key={seg.item.id} className="hc-turn__card">
                    <ToolCard item={seg.item} defaultExpanded={seg.item.isError === true} />
                    {request ? <PermissionCard request={request} onDecide={onPermissionDecision} /> : null}
                  </div>
                );
              }
              case 'node': {
                const node = seg.node;
                if (node.kind === 'subagent') {
                  const turnRouting = routing.get(node.item.id);
                  const request = pendingByToolUseId.get(node.item.toolUseId);
                  return (
                    <div key={node.item.id} className="hc-turn__card">
                      {turnRouting ? <SubagentRouting subagents={turnRouting} /> : null}
                      <SubagentCard node={node} renderChild={renderSubagentChild} />
                      {request ? <PermissionCard request={request} onDecide={onPermissionDecision} /> : null}
                    </div>
                  );
                }
                return node.item.type === 'image-gallery' ? (
                  <ImageGalleryCard key={node.item.id} paths={node.item.paths} />
                ) : null;
              }
              default:
                return null;
            }
          })}
          {activity ? <TurnActivity agent={agent} phase={activity.phase} startedAt={activity.startedAt} inline /> : null}
        </div>
      </div>
    </div>
  );
}

const MessageItem = memo(function MessageItem({
  item,
  agent,
  onEditResend,
  errorActions,
}: {
  item: ChatItem;
  agent: AgentKind;
  onEditResend?: (text: string) => void;
  errorActions?: ErrorCardActions | null;
}) {
  switch (item.type) {
    case 'user':
      return (
        <div className="hc-msg-user hc-msg-enter">
          <div className="hc-msg-actions hc-msg-actions--user">
            {onEditResend ? (
              <button
                type="button"
                className="hc-msg-action"
                aria-label="편집해서 다시 보내기"
                title="편집해서 다시 보내기"
                onClick={() => onEditResend(item.text)}
              >
                <GlyphEditResend width={14} height={14} />
              </button>
            ) : null}
            <CopyButton text={item.text} label="메시지 복사" className="hc-msg-action" />
          </div>
          <div className="hc-msg-user__bubble">
            {item.images && item.images.length > 0 ? <UserImages images={item.images} /> : null}
            {item.files && item.files.length > 0 ? <UserFiles files={item.files} /> : null}
            {item.text}
          </div>
        </div>
      );
    case 'assistant-text': {
      // A text that is only a "Model metadata for … not found"-style warning (no answer after it).
      const split = splitAgentWarning(item.text);
      return split ? (
        <div className="hc-msg-enter">
          <AgentWarningNotice warning={split.warning} />
        </div>
      ) : null;
    }
    case 'notice':
      if (item.level === 'error') {
        return (
          <div className="hc-error-enter">
            <ErrorCard item={item} agent={agent} actions={errorActions} />
          </div>
        );
      }
      return (
        <div className="hc-msg-enter">
          <SystemNotice item={item} />
        </div>
      );
    default:
      return null;
  }
});
