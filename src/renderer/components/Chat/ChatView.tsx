import { useCallback, useEffect, useState } from 'react';
import type { Account, ModelOption, PermissionDecision, Thread, UiPermissionMode } from '../../../shared/types';
import { formatResetCountdown } from '../../../core/format';
import { MINUTE_MS } from '../../../shared/constants';
import { selectChatItems, selectStreamingItemId, useAppStore, usePendingPermissions } from '../../store';
import { MessageList } from './MessageList';
import { Composer } from './Composer';
import { ThreadToolbar } from './ThreadToolbar';
import './Chat.css';

export interface ChatViewProps {
  thread: Thread;
  models: ModelOption[];
  accounts: Account[];
  onSend: (threadId: string, text: string) => void;
  onInterrupt: (threadId: string) => void;
  onPermissionDecision: (requestId: string, decision: PermissionDecision) => void;
  onModelChange: (threadId: string, model: string) => void;
  onPermissionModeChange: (threadId: string, mode: UiPermissionMode) => void;
  onPinAccountChange: (threadId: string, accountId: string | null) => void;
}

/**
 * Thread chat pane: toolbar + streaming transcript + composer (plan 4.4 Chat/**). Subscribes to the thread's
 * chat items / streaming id / pending permissions itself so text-deltas re-render only this subtree (M9).
 * Mount with `key={thread.id}` so the draft and scroll position are per thread (L8).
 */
export function ChatView({
  thread,
  models,
  accounts,
  onSend,
  onInterrupt,
  onPermissionDecision,
  onModelChange,
  onPermissionModeChange,
  onPinAccountChange,
}: ChatViewProps) {
  const items = useAppStore((s) => selectChatItems(s, thread.id));
  const streamingItemId = useAppStore((s) => selectStreamingItemId(s, thread.id));
  const permissionRequests = usePendingPermissions(thread.id);
  const threadId = thread.id;
  const running = thread.status === 'running';
  // Stable per-thread callbacks so the memoized toolbar / composer skip re-renders during streaming.
  const handleModel = useCallback((m: string) => onModelChange(threadId, m), [onModelChange, threadId]);
  const handleMode = useCallback((mode: UiPermissionMode) => onPermissionModeChange(threadId, mode), [onPermissionModeChange, threadId]);
  const handlePin = useCallback((accountId: string | null) => onPinAccountChange(threadId, accountId), [onPinAccountChange, threadId]);
  const handleSend = useCallback((text: string) => onSend(threadId, text), [onSend, threadId]);
  const handleInterrupt = useCallback(() => onInterrupt(threadId), [onInterrupt, threadId]);
  const waiting = thread.status === 'waiting';

  return (
    <div className="hc-chat">
      <ThreadToolbar
        models={models}
        model={thread.model}
        onModelChange={handleModel}
        permissionMode={thread.permissionMode}
        onPermissionModeChange={handleMode}
        accounts={accounts}
        pinnedAccountId={thread.pinnedAccountId}
        onPinAccountChange={handlePin}
        activeAccountId={thread.activeAccountId}
      />
      <MessageList
        items={items}
        streamingItemId={streamingItemId}
        permissionRequests={permissionRequests}
        onPermissionDecision={onPermissionDecision}
      />
      {waiting ? <WaitingBanner until={thread.waitingUntil} /> : null}
      <Composer
        running={running}
        disabled={false}
        onSend={handleSend}
        onInterrupt={handleInterrupt}
      />
    </div>
  );
}

function WaitingBanner({ until }: { until: number | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), MINUTE_MS);
    return () => window.clearInterval(id);
  }, []);
  const countdown = formatResetCountdown(until, now);
  return (
    <div className="hc-notice hc-notice--warn" role="status" style={{ margin: '0 var(--space-6) var(--space-2)' }}>
      All accounts are exhausted — waiting{countdown ? ` · resumes in ${countdown}` : ''}. Your message will send automatically.
    </div>
  );
}
