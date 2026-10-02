import { useCallback, useMemo, useRef, useState } from 'react';
import type { AttachmentInfo, CodexEffortLevel, EffortLevel, ModelOption, Project, UiPermissionMode } from '../../../shared/types';
import { AGENTS } from '../../../shared/agents';
import { draftAgentDefaults } from '../../../core/agentDefaults';
import { useAppStore, type DraftState } from '../../store';
import { BrandMark } from '../common';
import { Composer, type ComposerHandle } from './Composer';
import type { SlashSource } from './SlashMenu';
import { AcpModelChip, AgentChip, FolderChip, ModelPicker, PermissionChip, SystemModelTag } from './ComposerControls';
import { codexEffortChoices, codexModelChoices, effortValueLabel, hermesModelChip } from './acpChips';
import { BoltIcon } from './icons';
import { t } from '../../../shared/i18n';
import { tNodes } from '../../i18n';
import './Chat.css';

export interface DraftViewProps {
  draft: DraftState;
  projects: Project[];
  models: ModelOption[];
  onDraftChange: (patch: Partial<DraftState>) => void;
  /** "다른 폴더 선택…" (project:add). Resolves the chosen project, or null when cancelled. */
  onPickFolder: () => Promise<Project | null>;
  /** thread:start (with the composer attachments' ids). Resolves true when the thread was created (the composer clears). */
  onStart: (text: string, attachmentIds?: string[]) => Promise<boolean>;
  onAttachFiles: (projectId: string) => Promise<string[]>;
  /** What the `default` model runs as (e.g. "Fable 5"). */
  defaultModelLabel: string;
  homeDir: string | null;
}

/** Time-of-day greeting. */
export function greeting(date: Date = new Date()): string {
  const h = date.getHours();
  if (h < 5) return t('draft.greeting.night');
  if (h < 12) return t('draft.greeting.morning');
  if (h < 18) return t('draft.greeting.afternoon');
  return t('draft.greeting.evening');
}

/**
 * The new-chat screen (draft): brand + prompt centred, the composer below it with the folder chip. Nothing
 * exists in main until the first send creates the thread (thread:start).
 */
export function DraftView({
  draft,
  projects,
  models,
  onDraftChange,
  onPickFolder,
  onStart,
  onAttachFiles,
  defaultModelLabel,
  homeDir,
}: DraftViewProps) {
  const [folderOpen, setFolderOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const composerRef = useRef<ComposerHandle>(null);
  const project = projects.find((p) => p.id === draft.projectId) ?? null;
  const prefill = useAppStore((s) => (s.composerPrefill?.target === 'draft' ? s.composerPrefill : null));
  const clearPrefill = useCallback(() => useAppStore.getState().clearComposerPrefill(), []);
  const localAuth = useAppStore((s) => s.localAuth);
  const threads = useAppStore((s) => s.threads);
  const features = AGENTS[draft.agent].features;
  // No session yet: Claude lists the scanned skills / commands, ACP agents report theirs once a session opens.
  const slash = useMemo<SlashSource>(
    () =>
      draft.agent === 'claude-code'
        ? { kind: 'claude', projectId: draft.projectId }
        : { kind: 'acp', agentName: AGENTS[draft.agent].name, commands: undefined },
    [draft.agent, draft.projectId],
  );
  const codexEfforts = useMemo(() => (draft.agent === 'codex' ? codexEffortChoices(threads) : []), [draft.agent, threads]);
  const codexModels = useMemo(
    () => (draft.agent === 'codex' ? codexModelChoices(threads, draft.model) : []),
    [draft.agent, draft.model, threads],
  );

  const pickOther = useCallback(() => {
    void onPickFolder()
      .then((p) => {
        if (p) onDraftChange({ projectId: p.id });
        composerRef.current?.focus();
      })
      .catch((err: unknown) => console.error('[deltax] folder pick failed', err));
  }, [onPickFolder, onDraftChange]);

  // No folder is not an error: the thread starts as a chat without a project (scratch folder, plan 2.12).
  const send = useCallback(
    async (text: string, attachments?: AttachmentInfo[]) => {
      setStarting(true);
      try {
        return await onStart(text, attachments?.map((a) => a.id));
      } finally {
        setStarting(false);
      }
    },
    [onStart],
  );

  const attach = useCallback(async () => (draft.projectId ? onAttachFiles(draft.projectId) : []), [draft.projectId, onAttachFiles]);
  // No session yet: ACP agents are judged by their default prompt capabilities until the thread's session reports.
  const attachTarget = useMemo(
    () => ({ agent: draft.agent, caps: null, ...(draft.projectId ? { projectId: draft.projectId } : {}) }),
    [draft.agent, draft.projectId],
  );
  const setMode = useCallback((permissionMode: UiPermissionMode) => onDraftChange({ permissionMode }), [onDraftChange]);
  const setModel = useCallback((model: string) => onDraftChange({ model }), [onDraftChange]);
  const setEffort = useCallback((effort: EffortLevel | null) => onDraftChange({ effort }), [onDraftChange]);
  // Switching agents resets model / effort to that agent's new-chat defaults (Opus 5.5 · High, GPT-6.1-Sol · High,
  // Hermes' system default).
  const setAgent = useCallback(
    (agent: DraftState['agent']) => {
      if (agent === draft.agent) return;
      onDraftChange({ agent, ...draftAgentDefaults(agent, useAppStore.getState().settings) });
    },
    [draft.agent, onDraftChange],
  );
  const recheckAgents = useCallback(() => {
    void useAppStore
      .getState()
      .recheckAgents()
      .catch((err: unknown) => console.error('[deltax] agent recheck failed', err));
  }, []);
  const setCodexEffort = useCallback((value: string) => onDraftChange({ effort: value as CodexEffortLevel }), [onDraftChange]);

  const trailing =
    draft.agent === 'hermes' ? (
      <SystemModelTag {...hermesModelChip(null, localAuth.find((i) => i.agent === 'hermes'))} />
    ) : draft.agent === 'codex' ? (
      <AcpModelChip
        model={draft.model}
        effort={draft.effort}
        modelLabel={codexModels.find((m) => m.value === draft.model)?.label ?? draft.model}
        effortLabel={draft.effort ? effortValueLabel(draft.effort) : null}
        models={codexModels}
        efforts={codexEfforts}
        onModelChange={setModel}
        onEffortChange={setCodexEffort}
      />
    ) : (
      <ModelPicker
        models={models}
        model={draft.model}
        effort={draft.effort === 'ultra' ? null : draft.effort}
        defaultLabel={defaultModelLabel}
        onModelChange={setModel}
        onEffortChange={setEffort}
      />
    );

  return (
    <div className="hc-draft" data-testid="draft">
      <div className="hc-draft__hero">
        <div className="hc-draft__mark" aria-hidden>
          <BrandMark size={64} />
        </div>
        <p className="hc-draft__greeting">{greeting()}</p>
        <h1 className="hc-draft__title">{t('draft.title')}</h1>
        {project ? (
          <p className="hc-draft__sub">
            {draft.base ? (
              <span data-testid="draft-pr-base">
                {tNodes(
                  'draft.base',
                  {
                    project: <span className="hc-draft__folder">{project.name}</span>,
                    branch: <span className="hc-draft__folder">{draft.base.branch}</span>,
                  },
                  { pr: draft.base.pr },
                )}{' '}
                <button type="button" className="hc-draft__base-clear" onClick={() => onDraftChange({ base: null })}>
                  {t('draft.base.clear')}
                </button>
              </span>
            ) : (
              <>
                {tNodes('draft.worktree', { project: <span className="hc-draft__folder">{project.name}</span> })}
              </>
            )}
          </p>
        ) : null}
      </div>
      <Composer
        handleRef={composerRef}
        size="lg"
        autoFocus
        running={false}
        busy={starting}
        disabled={starting}
        onSend={send}
        onAttachFiles={draft.projectId ? attach : undefined}
        attach={attachTarget}
        canChangeFolder
        onChangeFolder={() => setFolderOpen(true)}
        prefill={prefill}
        onPrefillApplied={clearPrefill}
        slash={slash}
        homeDir={homeDir}
        leading={
          <>
            <AgentChip value={draft.agent} onChange={setAgent} localAuth={localAuth} onRecheck={recheckAgents} />
            <FolderChip
              projects={projects}
              projectId={draft.projectId}
              onSelect={(projectId) => onDraftChange({ projectId })}
              onPickOther={pickOther}
              open={folderOpen}
              onOpenChange={setFolderOpen}
              homeDir={homeDir}
            />
            {features.permissionModes ? <PermissionChip value={draft.permissionMode} onChange={setMode} agent={draft.agent} /> : null}
          </>
        }
        trailing={trailing}
      />
      <div className="hc-newtask-row">
        <button
          type="button"
          className="hc-newtask-btn"
          data-testid="new-task-start"
          onClick={() => useAppStore.getState().startNewTask()}
        >
          <BoltIcon width={15} height={15} />
          New Task Start
        </button>
      </div>
    </div>
  );
}
