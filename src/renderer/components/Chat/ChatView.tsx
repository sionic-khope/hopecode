import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AttachmentInfo, ChatImage, ChatItem, EffortLevel, ModelOption, PermissionDecision, Project, Thread, UiPermissionMode } from '../../../shared/types';
import { formatResetCountdown } from '../../../core/format';
import { MINUTE_MS } from '../../../shared/constants';
import { AGENTS } from '../../../shared/agents';
import { ipcErrorMessage } from '../../errors';
import { selectChatItems, selectStreamingItemId, selectTurnPhase, useAppStore, usePendingPermissions, type TurnPhase } from '../../store';
import { MessageList } from './MessageList';
import { ToolPathContext, TurnLiveContext } from './ToolCard';
import type { ErrorCardActions } from './ErrorCard';
import { Composer } from './Composer';
import type { SlashSource } from './SlashMenu';
import { AcpModelChip, AgentChip, AgentModeChip, FolderTag, ModelPicker, NO_PROJECT_LABEL, PermissionChip, SystemModelTag } from './ComposerControls';
import { agentModeChip, codexThreadChip, hermesModelChip } from './acpChips';
import './Chat.css';

export interface ChatViewProps {
  thread: Thread;
  project: Project | null;
  models: ModelOption[];
  /** `images`: inline images (error card retry); `attachmentIds`: composer attachments main validated. */
  onSend: (threadId: string, text: string, images?: ChatImage[], attachmentIds?: string[]) => void;
  onInterrupt: (threadId: string) => void;
  onPermissionDecision: (requestId: string, decision: PermissionDecision) => void;
  onModelChange: (threadId: string, model: string) => void;
  onEffortChange: (threadId: string, effort: EffortLevel | null) => void;
  onPermissionModeChange: (threadId: string, mode: UiPermissionMode) => void;
  onAttachFiles: (threadId: string) => Promise<string[]>;
  /** Error card "새 세션으로 시도": a new thread like this one, started with `text`. */
  onRetryInNewSession?: (thread: Thread, text: string) => void;
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
  onSend,
  onInterrupt,
  onPermissionDecision,
  onModelChange,
  onEffortChange,
  onPermissionModeChange,
  onAttachFiles,
  onRetryInNewSession,
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
  const handleSend = useCallback(
    (text: string, attachments?: AttachmentInfo[]) => {
      if (attachments && attachments.length > 0) onSend(threadId, text, undefined, attachments.map((a) => a.id));
      else onSend(threadId, text);
      return true;
    },
    [onSend, threadId],
  );
  const handleInterrupt = useCallback(() => onInterrupt(threadId), [onInterrupt, threadId]);
  const handleAttach = useCallback(() => onAttachFiles(threadId), [onAttachFiles, threadId]);
  const waiting = thread.status === 'waiting';
  const toolPaths = useMemo(() => ({ cwd: thread.cwd, home: homeDir }), [thread.cwd, homeDir]);
  const setChatScrolled = useAppStore((s) => s.setChatScrolled);
  const prefill = useAppStore((s) => (s.composerPrefill?.target === threadId ? s.composerPrefill : null));
  const clearPrefill = useCallback(() => useAppStore.getState().clearComposerPrefill(), []);
  const handleEditResend = useCallback((text: string) => useAppStore.getState().prefillComposer(threadId, text), [threadId]);
  const [controlError, setControlError] = useState<string | null>(null);
  // ACP controls: the applied value comes back through `agent:controls` / `thread:updated`.
  const handleAgentConfig = useCallback(
    (configId: string, value: string) => {
      setControlError(null);
      void useAppStore
        .getState()
        .setThreadAgentConfig(threadId, configId, value)
        .catch((err: unknown) => setControlError(`설정을 바꾸지 못했습니다: ${ipcErrorMessage(err)}`));
    },
    [threadId],
  );
  const handleAgentMode = useCallback(
    (modeId: string) => {
      setControlError(null);
      void useAppStore
        .getState()
        .setThreadAgentMode(threadId, modeId)
        .catch((err: unknown) => setControlError(`모드를 바꾸지 못했습니다: ${ipcErrorMessage(err)}`));
    },
    [threadId],
  );
  const phase = useAppStore((s) => selectTurnPhase(s, threadId));
  const activity = useMemo(
    () => turnActivity(items, running, streamingItemId, permissionRequests.length, phase),
    [items, running, streamingItemId, permissionRequests.length, phase],
  );
  const lastUser = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i]!;
      if (it.type === 'user') return it;
    }
    return null;
  }, [items]);
  const errorActions = useMemo<ErrorCardActions | null>(() => {
    if (!lastUser) return null;
    return {
      message: lastUser.text,
      disabled: running,
      onRetry: () => onSend(threadId, lastUser.text, lastUser.images),
      onRetryInNewSession: () => onRetryInNewSession?.(thread, lastUser.text),
    };
  }, [lastUser, running, onSend, threadId, onRetryInNewSession, thread]);
  const features = AGENTS[thread.agent].features;
  const acpCommands = thread.acp?.controls?.commands;
  const slash = useMemo<SlashSource>(
    () =>
      thread.agent === 'claude-code'
        ? { kind: 'claude', threadId: thread.id }
        : { kind: 'acp', agentName: AGENTS[thread.agent].name, commands: acpCommands },
    [thread.agent, thread.id, acpCommands],
  );
  const promptCaps = thread.acp?.promptCapabilities ?? null;
  const attach = useMemo(() => ({ agent: thread.agent, caps: promptCaps, threadId: thread.id }), [thread.agent, promptCaps, thread.id]);
  const codex = thread.agent === 'codex' ? codexThreadChip(thread) : null;
  const modeChip = features.agentModes ? agentModeChip(thread.acp) : null;

  const hermesInfo = useAppStore((s) => s.localAuth.find((i) => i.agent === 'hermes'));
  const trailing =
    thread.agent === 'hermes' ? (
      <SystemModelTag {...hermesModelChip(thread.acp?.controls?.reportedModel, hermesInfo)} />
    ) : codex ? (
      <AcpModelChip
        model={codex.model}
        effort={codex.effort}
        modelLabel={codex.modelLabel}
        effortLabel={codex.effortLabel}
        models={codex.models}
        efforts={codex.efforts}
        readOnlyTitle={codex.modelConfigId || codex.effortConfigId ? undefined : 'Codex 세션이 열리면 바꿀 수 있습니다'}
        onModelChange={codex.modelConfigId ? (v) => handleAgentConfig(codex.modelConfigId as string, v) : undefined}
        onEffortChange={codex.effortConfigId ? (v) => handleAgentConfig(codex.effortConfigId as string, v) : undefined}
      />
    ) : (
      <ModelPicker
        models={models}
        model={thread.model}
        effort={thread.effort === 'ultra' ? null : thread.effort}
        resolvedModel={thread.resolvedModel}
        defaultLabel={defaultModelLabel}
        onModelChange={handleModel}
        onEffortChange={handleEffort}
      />
    );

  return (
    <div className="hc-chat">
      <ToolPathContext.Provider value={toolPaths}>
      <TurnLiveContext.Provider value={running}>
      <MessageList
        items={items}
        streamingItemId={streamingItemId}
        permissionRequests={permissionRequests}
        onPermissionDecision={onPermissionDecision}
        onScrolledChange={setChatScrolled}
        agent={thread.agent}
        onEditResend={handleEditResend}
        threadId={thread.id}
        activity={activity}
        errorActions={errorActions}
      />
      </TurnLiveContext.Provider>
      </ToolPathContext.Provider>
      {waiting ? <WaitingBanner until={thread.waitingUntil} /> : null}
      {controlError ? (
        <div className="hc-notice hc-notice--error hc-chat__waiting" role="alert" onClick={() => setControlError(null)}>
          {controlError}
        </div>
      ) : null}
      <Composer
        running={running}
        onSend={handleSend}
        onInterrupt={handleInterrupt}
        onAttachFiles={handleAttach}
        attach={attach}
        canChangeFolder={false}
        prefill={prefill}
        onPrefillApplied={clearPrefill}
        slash={slash}
        homeDir={homeDir}
        leading={
          <>
            <AgentChip value={thread.agent} />
            {project ? (
              <FolderTag
                name={project.name}
                path={thread.worktree ? `${project.path} · ${thread.worktree.branch}` : project.path}
                homeDir={homeDir}
              />
            ) : thread.projectId === null ? (
              <FolderTag name={NO_PROJECT_LABEL} path={thread.cwd} homeDir={homeDir} />
            ) : null}
            {features.permissionModes ? <PermissionChip value={thread.permissionMode} onChange={handleMode} agent={thread.agent} /> : null}
            {modeChip ? (
              <AgentModeChip label={modeChip.label} currentModeId={modeChip.currentModeId} modes={modeChip.modes} onChange={handleAgentMode} />
            ) : null}
          </>
        }
        trailing={trailing}
      />
    </div>
  );
}

/**
 * The "생각 중" row: a running turn with nothing streaming, no permission question and no tool running (a running
 * tool card shows its own progress). Without a phase from turn-start (renderer reloaded mid-turn) it counts from
 * the last user message.
 */
function turnActivity(
  items: readonly ChatItem[],
  running: boolean,
  streamingItemId: string | null,
  pendingPermissions: number,
  phase: TurnPhase | null,
): TurnPhase | null {
  if (!running || streamingItemId !== null || pendingPermissions > 0) return null;
  let lastUserAt: number | null = null;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.type === 'user') {
      lastUserAt = it.createdAt;
      break;
    }
    if (it.type === 'tool' && it.result === undefined && !it.parentToolUseId) return null;
  }
  if (phase) return phase;
  return { phase: 'thinking', startedAt: lastUserAt ?? Date.now() };
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
