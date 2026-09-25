import { useCallback, useEffect, useState } from 'react';
import type { Account, EffortLevel, ModelOption, PermissionDecision, Project, Thread, UiPermissionMode } from '../../../shared/types';
import { formatResetCountdown } from '../../../core/format';
import { MINUTE_MS } from '../../../shared/constants';
import { selectChatItems, selectStreamingItemId, useAppStore, usePendingPermissions } from '../../store';
import { MessageList } from './MessageList';
import { Composer } from './Composer';
import { AccountChip, FolderTag, ModelPicker, PermissionChip } from './ComposerControls';
import './Chat.css';

export interface ChatViewProps {
  thread: Thread;
  project: Project | null;
  models: ModelOption[];
  accounts: Account[];
  onSend: (threadId: string, text: string) => void;
  onInterrupt: (threadId: string) => void;
  onPermissionDecision: (requestId: string, decision: PermissionDecision) => void;
  onModelChange: (threadId: string, model: string) => void;
  onEffortChange: (threadId: string, effort: EffortLevel | null) => void;
  onPermissionModeChange: (threadId: string, mode: UiPermissionMode) => void;
  onPinAccountChange: (threadId: string, accountId: string | null) => void;
  onAttachFiles: (threadId: string) => Promise<string[]>;
  /** What the `default` model runs as (e.g. "Fable 5"). */
  defaultModelLabel: string;
  homeDir: string | null;
}

/**
 * Thread chat pane: streaming transcript + composer carrying the thread's controls (plan 4.4 Chat/**).
 * Subscribes to the thread's chat items / streaming id / pending permissions itself so text-deltas re-render only
 * this subtree (M9). Mount with `key={thread.id}` so the draft text and scroll position are per thread (L8).
 */
export function ChatView({
  thread,
  project,
  models,
  accounts,
  onSend,
  onInterrupt,
  onPermissionDecision,
  onModelChange,
  onEffortChange,
  onPermissionModeChange,
  onPinAccountChange,
  onAttachFiles,
  defaultModelLabel,
  homeDir,
}: ChatViewProps) {
  const items = useAppStore((s) => selectChatItems(s, thread.id));
  const streamingItemId = useAppStore((s) => selectStreamingItemId(s, thread.id));
  const permissionRequests = usePendingPermissions(thread.id);
  const threadId = thread.id;
  const running = thread.status === 'running';
  // Stable per-thread callbacks so the memoized composer chips skip re-renders during streaming.
  const handleModel = useCallback((m: string) => onModelChange(threadId, m), [onModelChange, threadId]);
  const handleEffort = useCallback((e: EffortLevel | null) => onEffortChange(threadId, e), [onEffortChange, threadId]);
  const handleMode = useCallback((mode: UiPermissionMode) => onPermissionModeChange(threadId, mode), [onPermissionModeChange, threadId]);
  const handlePin = useCallback((accountId: string | null) => onPinAccountChange(threadId, accountId), [onPinAccountChange, threadId]);
  const handleSend = useCallback(
    (text: string) => {
      onSend(threadId, text);
      return true;
    },
    [onSend, threadId],
  );
  const handleInterrupt = useCallback(() => onInterrupt(threadId), [onInterrupt, threadId]);
  const handleAttach = useCallback(() => onAttachFiles(threadId), [onAttachFiles, threadId]);
  const waiting = thread.status === 'waiting';
  const setChatScrolled = useAppStore((s) => s.setChatScrolled);

  return (
    <div className="hc-chat">
      <MessageList
        items={items}
        streamingItemId={streamingItemId}
        permissionRequests={permissionRequests}
        onPermissionDecision={onPermissionDecision}
        onScrolledChange={setChatScrolled}
      />
      {waiting ? <WaitingBanner until={thread.waitingUntil} /> : null}
      <Composer
        running={running}
        onSend={handleSend}
        onInterrupt={handleInterrupt}
        onAttachFiles={handleAttach}
        canChangeFolder={false}
        leading={
          <>
            {project ? (
              <FolderTag
                name={project.name}
                path={thread.worktree ? `${project.path} · ${thread.worktree.branch}` : project.path}
                homeDir={homeDir}
              />
            ) : null}
            <PermissionChip value={thread.permissionMode} onChange={handleMode} />
            <AccountChip
              accounts={accounts}
              pinnedAccountId={thread.pinnedAccountId}
              activeAccountId={thread.activeAccountId}
              onChange={handlePin}
            />
          </>
        }
        trailing={
          <ModelPicker
            models={models}
            model={thread.model}
            effort={thread.effort}
            resolvedModel={thread.resolvedModel}
            defaultLabel={defaultModelLabel}
            onModelChange={handleModel}
            onEffortChange={handleEffort}
          />
        }
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
    <div className="hc-notice hc-notice--warn hc-chat__waiting" role="status">
      모든 계정이 한도에 도달해 대기 중입니다{countdown ? ` · ${countdown} 후 재개` : ''}. 메시지는 자동으로 전송됩니다.
    </div>
  );
}
