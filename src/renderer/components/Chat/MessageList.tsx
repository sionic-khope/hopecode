import { memo, useEffect, useRef } from 'react';
import type { ChatItem, PermissionDecision, PermissionRequest } from '../../../shared/types';
import { AssistantText } from './AssistantText';
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
          {items.map((item) => {
            const pendingRequest = item.type === 'tool' ? byToolUseId.get(item.toolUseId) : undefined;
            if (pendingRequest) rendered.add(pendingRequest.requestId);
            return (
              <MessageItem
                key={item.id}
                item={item}
                streaming={item.id === streamingItemId}
                pendingRequest={pendingRequest}
                onPermissionDecision={onPermissionDecision}
              />
            );
          })}
          {permissionRequests
            .filter((r) => !rendered.has(r.requestId))
            .map((r) => (
              <PermissionCard key={r.requestId} request={r} onDecide={onPermissionDecision} />
            ))}
        </div>
      )}
    </div>
  );
}

const MessageItem = memo(function MessageItem({
  item,
  streaming,
  pendingRequest,
  onPermissionDecision,
}: {
  item: ChatItem;
  streaming: boolean;
  pendingRequest?: PermissionRequest;
  onPermissionDecision: (requestId: string, decision: PermissionDecision) => void;
}) {
  switch (item.type) {
    case 'user':
      return (
        <div className="hc-msg-user">
          <div className="hc-msg-user__bubble">{item.text}</div>
        </div>
      );
    case 'assistant-text':
      return <AssistantText text={item.text} streaming={streaming} />;
    case 'tool':
      return (
        <>
          <ToolCard item={item} defaultExpanded={item.isError === true} />
          {pendingRequest ? <PermissionCard request={pendingRequest} onDecide={onPermissionDecision} /> : null}
        </>
      );
    case 'notice':
      return <SystemNotice item={item} />;
    default:
      return null;
  }
});
