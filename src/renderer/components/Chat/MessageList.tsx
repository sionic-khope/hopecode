import { memo, useEffect, useMemo, useRef, type ReactNode } from 'react';
import type { AgentKind, ChatItem, PermissionDecision, PermissionRequest } from '../../../shared/types';
import { AGENTS } from '../../../shared/agents';
import { AgentIcon } from '../Agent/AgentIcon';
import { GlyphEditResend } from '../common/glyphs';
import { AssistantText } from './AssistantText';
import { CopyButton } from './CopyButton';
import { ToolCard } from './ToolCard';
import { PermissionCard } from './PermissionCard';
import { SystemNotice } from './SystemNotice';
import { buildChatTree, type ChatNode, type SubagentSummary } from '../../../core/subagents';
import { SubagentCard, SubagentRouting } from '../Subagents/SubagentCard';
import { ImageGalleryCard, ThreadImageContext, UserImages } from '../Images/ChatImages';
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
}

const NEAR_BOTTOM_PX = 96;

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

/** Item nested in a subagent card (no avatar gutter). */
function renderSubagentChild(node: ChatNode): ReactNode {
  if (node.kind === 'subagent') return <SubagentCard node={node} renderChild={renderSubagentChild} />;
  const item = node.item;
  if (item.type === 'assistant-text') return <AssistantText text={item.text} streaming={false} />;
  if (item.type === 'tool') return <ToolCard item={item} defaultExpanded={item.isError === true} />;
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
}: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickToBottom.current) return;
    el.scrollTop = el.scrollHeight;
    onScrolledChange?.(el.scrollTop > 0);
  }, [items, streamingItemId, permissionRequests, onScrolledChange]);

  useEffect(() => () => onScrolledChange?.(false), [onScrolledChange]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    onScrolledChange?.(el.scrollTop > 0);
  };

  const byToolUseId = new Map(permissionRequests.map((r) => [r.toolUseId, r]));
  const rendered = new Set<string>();
  // Subagent frames nest under their Task/Agent card; permission requests of nested calls stay in the bottom list.
  const nodes = useMemo(() => buildChatTree(items), [items]);
  const routing = useMemo(() => routingByTurn(nodes), [nodes]);

  return (
    <ThreadImageContext.Provider value={threadId ?? null}>
    <div className="hc-messages" ref={scrollRef} onScroll={onScroll}>
      {items.length === 0 && permissionRequests.length === 0 ? (
        <div className="hc-messages__empty">{emptyLabel}</div>
      ) : (
        <div className="hc-messages__inner">
          {nodes.map((node, i) => {
            const item = node.item;
            const pendingRequest = item.type === 'tool' ? byToolUseId.get(item.toolUseId) : undefined;
            if (pendingRequest) rendered.add(pendingRequest.requestId);
            // The agent avatar opens each run of agent output (text / tools / galleries) after a user message.
            const prev = i > 0 ? nodes[i - 1]?.item : undefined;
            const isAgent = (it: ChatItem | undefined) =>
              !!it && (it.type === 'assistant-text' || it.type === 'tool' || it.type === 'image-gallery');
            const leadsRun = isAgent(item) && !isAgent(prev);
            if (node.kind === 'subagent') {
              const turnRouting = routing.get(item.id);
              return (
                <AgentRow key={item.id} agent={agent} leadsRun={leadsRun}>
                  {turnRouting ? <SubagentRouting subagents={turnRouting} /> : null}
                  <SubagentCard node={node} renderChild={renderSubagentChild} />
                  {pendingRequest ? <PermissionCard request={pendingRequest} onDecide={onPermissionDecision} /> : null}
                </AgentRow>
              );
            }
            return (
              <MessageItem
                key={item.id}
                item={item}
                agent={agent}
                leadsRun={leadsRun}
                streaming={item.id === streamingItemId}
                pendingRequest={pendingRequest}
                onPermissionDecision={onPermissionDecision}
                onEditResend={onEditResend}
              />
            );
          })}
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
    </ThreadImageContext.Provider>
  );
}

/** Agent column: avatar gutter (filled on the first item of a run) + content. */
function AgentRow({ agent, leadsRun, children }: { agent: AgentKind; leadsRun: boolean; children: ReactNode }) {
  return (
    <div className={`hc-agent-row hc-msg-enter${leadsRun ? ' hc-agent-row--lead' : ''}`}>
      <span className="hc-agent-row__avatar">
        {leadsRun ? (
          <span className="hc-agent-avatar" title={AGENTS[agent].name} aria-label={AGENTS[agent].name} role="img">
            <AgentIcon kind={agent} size={15} />
          </span>
        ) : null}
      </span>
      <div className="hc-agent-row__body">{children}</div>
    </div>
  );
}

const MessageItem = memo(function MessageItem({
  item,
  agent,
  leadsRun,
  streaming,
  pendingRequest,
  onPermissionDecision,
  onEditResend,
}: {
  item: ChatItem;
  agent: AgentKind;
  leadsRun: boolean;
  streaming: boolean;
  pendingRequest?: PermissionRequest;
  onPermissionDecision: (requestId: string, decision: PermissionDecision) => void;
  onEditResend?: (text: string) => void;
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
            {item.text}
          </div>
        </div>
      );
    case 'assistant-text':
      return (
        <AgentRow agent={agent} leadsRun={leadsRun}>
          <AssistantText text={item.text} streaming={streaming} />
          {streaming ? null : (
            <div className="hc-msg-actions hc-msg-actions--agent">
              <CopyButton text={item.text} label="답변 복사" className="hc-msg-action" />
            </div>
          )}
        </AgentRow>
      );
    case 'tool':
      return (
        <AgentRow agent={agent} leadsRun={leadsRun}>
          <ToolCard item={item} defaultExpanded={item.isError === true} />
          {pendingRequest ? <PermissionCard request={pendingRequest} onDecide={onPermissionDecision} /> : null}
        </AgentRow>
      );
    case 'image-gallery':
      return (
        <AgentRow agent={agent} leadsRun={leadsRun}>
          <ImageGalleryCard paths={item.paths} />
        </AgentRow>
      );
    case 'notice':
      return (
        <div className="hc-msg-enter">
          <SystemNotice item={item} />
        </div>
      );
    default:
      return null;
  }
});
