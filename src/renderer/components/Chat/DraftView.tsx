import { useCallback, useRef, useState } from 'react';
import type { Account, EffortLevel, ModelOption, Project, UiPermissionMode } from '../../../shared/types';
import type { DraftState } from '../../store';
import { BrandMark } from '../common';
import { Composer, type ComposerHandle } from './Composer';
import { AccountChip, FolderChip, ModelPicker, PermissionChip } from './ComposerControls';
import './Chat.css';

export interface DraftViewProps {
  draft: DraftState;
  projects: Project[];
  models: ModelOption[];
  accounts: Account[];
  onDraftChange: (patch: Partial<DraftState>) => void;
  /** "다른 폴더 선택…" (project:add). Resolves the chosen project, or null when cancelled. */
  onPickFolder: () => Promise<Project | null>;
  /** thread:start. Resolves true when the thread was created (the composer clears). */
  onStart: (text: string) => Promise<boolean>;
  onAttachFiles: (projectId: string) => Promise<string[]>;
  /** What the `default` model runs as (e.g. "Fable 5"). */
  defaultModelLabel: string;
  homeDir: string | null;
}

/**
 * The new-chat screen (draft): brand + prompt centred, the composer below it with the folder chip. Nothing
 * exists in main until the first send creates the thread (thread:start).
 */
export function DraftView({
  draft,
  projects,
  models,
  accounts,
  onDraftChange,
  onPickFolder,
  onStart,
  onAttachFiles,
  defaultModelLabel,
  homeDir,
}: DraftViewProps) {
  const [folderOpen, setFolderOpen] = useState(false);
  /** Bumped by every send without a folder: re-keys the chip so its pulse replays. */
  const [pulse, setPulse] = useState(0);
  const [starting, setStarting] = useState(false);
  const composerRef = useRef<ComposerHandle>(null);
  const project = projects.find((p) => p.id === draft.projectId) ?? null;

  const needFolder = pulse > 0 && !project;

  const pickOther = useCallback(() => {
    void onPickFolder()
      .then((p) => {
        if (p) onDraftChange({ projectId: p.id });
        composerRef.current?.focus();
      })
      .catch((err: unknown) => console.error('[hopecode] folder pick failed', err));
  }, [onPickFolder, onDraftChange]);

  const send = useCallback(
    async (text: string) => {
      if (!draft.projectId) {
        setPulse((n) => n + 1);
        setFolderOpen(true);
        return false;
      }
      setStarting(true);
      try {
        return await onStart(text);
      } finally {
        setStarting(false);
      }
    },
    [draft.projectId, onStart],
  );

  const attach = useCallback(async () => (draft.projectId ? onAttachFiles(draft.projectId) : []), [draft.projectId, onAttachFiles]);
  const setMode = useCallback((permissionMode: UiPermissionMode) => onDraftChange({ permissionMode }), [onDraftChange]);
  const setModel = useCallback((model: string) => onDraftChange({ model }), [onDraftChange]);
  const setEffort = useCallback((effort: EffortLevel | null) => onDraftChange({ effort }), [onDraftChange]);
  const setPin = useCallback((pinnedAccountId: string | null) => onDraftChange({ pinnedAccountId }), [onDraftChange]);

  return (
    <div className="hc-draft" data-testid="draft">
      <div className="hc-draft__hero">
        <div className="hc-draft__mark" aria-hidden>
          <BrandMark size={44} />
        </div>
        <h1 className="hc-draft__title">무엇을 만들어 볼까요?</h1>
        <p className="hc-draft__sub">
          {project ? (
            <>
              <span className="hc-draft__folder">{project.name}</span>에서 새 worktree로 시작합니다
            </>
          ) : (
            '작업할 폴더를 고르고 요청을 입력하세요'
          )}
        </p>
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
        canChangeFolder
        onChangeFolder={() => setFolderOpen(true)}
        leading={
          <>
            <FolderChip
              key={pulse}
              projects={projects}
              projectId={draft.projectId}
              onSelect={(projectId) => onDraftChange({ projectId })}
              onPickOther={pickOther}
              open={folderOpen}
              onOpenChange={setFolderOpen}
              attention={needFolder}
              homeDir={homeDir}
            />
            <PermissionChip value={draft.permissionMode} onChange={setMode} />
            <AccountChip accounts={accounts} pinnedAccountId={draft.pinnedAccountId} onChange={setPin} />
          </>
        }
        trailing={
          <ModelPicker
            models={models}
            model={draft.model}
            effort={draft.effort}
            defaultLabel={defaultModelLabel}
            onModelChange={setModel}
            onEffortChange={setEffort}
          />
        }
      />
      {/* Reserved line so the alert never shifts the composer. */}
      <div className="hc-draft__hint" role={needFolder ? 'alert' : undefined}>
        {needFolder ? '먼저 작업할 폴더를 선택하세요' : null}
      </div>
    </div>
  );
}
