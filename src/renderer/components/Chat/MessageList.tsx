import { memo, useEffect, useRef, type ReactNode } from 'react';
import type { AgentKind, ChatItem, PermissionDecision, PermissionRequest } from '../../../shared/types';
import { AGENTS } from '../../../shared/agents';
import { AgentIcon } from '../Agent/AgentIcon';
import { GlyphEditResend } from '../common/glyphs';
import { AssistantText } from './AssistantText';
import { CopyButton } from './CopyButton';
import { ToolCard } from './ToolCard';
import { PermissionCard } from './PermissionCard';
import { SystemNotice } from './SystemNotice';
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
}

const NEAR_BOTTOM_PX = 96;

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

  return (
    <div className="hc-messages" ref={scrollRef} onScroll={onScroll}>
      {items.length === 0 && permissionRequests.length === 0 ? (
        <div className="hc-messages__empty">{emptyLabel}</div>
      ) : (
        <div className="hc-messages__inner">
          {items.map((item, i) => {
            const pendingRequest = item.type === 'tool' ? byToolUseId.get(item.toolUseId) : undefined;
            if (pendingRequest) rendered.add(pendingRequest.requestId);
            // The agent avatar opens each run of agent output (text / tools) after a user message.
            const prev = i > 0 ? items[i - 1] : undefined;
            const agentItem = item.type === 'assistant-text' || item.type === 'tool';
            const leadsRun = agentItem && !(prev && (prev.type === 'assistant-text' || prev.type === 'tool'));
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
          <div className="hc-msg-user__bubble">{item.text}</div>
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
