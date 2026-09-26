import { useCallback, useRef, useState } from 'react';
import type { Account, EffortLevel, ModelOption, Project, UiPermissionMode } from '../../../shared/types';
import { useAppStore, type DraftState } from '../../store';
import { BrandMark } from '../common';
import { GlyphBranch, GlyphChanges, GlyphCode, GlyphTerminal } from '../common/glyphs';
import { Composer, type ComposerHandle } from './Composer';
import { AccountChip, AgentChip, FolderChip, ModelPicker, PermissionChip } from './ComposerControls';
import { BoltIcon } from './icons';
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

/** Starter prompts on the empty screen; a click puts the text in the composer (nothing is sent). */
export const SUGGESTED_PROMPTS: readonly { key: string; title: string; text: string; icon: 'tour' | 'bug' | 'test' | 'docs' }[] = [
  { key: 'tour', title: '코드베이스 둘러보기', text: '이 저장소의 구조와 주요 모듈이 어떻게 연결되는지 설명해 주세요.', icon: 'tour' },
  { key: 'bug', title: '버그 찾아 고치기', text: '최근 변경 사항에서 버그가 생길 만한 곳을 찾아 원인을 설명하고 고쳐 주세요.', icon: 'bug' },
  { key: 'test', title: '테스트 보강하기', text: '테스트가 부족한 핵심 로직을 찾아 단위 테스트를 추가해 주세요.', icon: 'test' },
  { key: 'docs', title: 'README 다듬기', text: 'README를 읽고 설치·실행 방법에서 빠지거나 오래된 부분을 보완해 주세요.', icon: 'docs' },
];

const SUGGESTION_ICON = {
  tour: <GlyphCode width={16} height={16} />,
  bug: <GlyphBranch width={16} height={16} />,
  test: <GlyphTerminal width={16} height={16} />,
  docs: <GlyphChanges width={16} height={16} />,
} as const;

/** Time-of-day greeting. */
export function greeting(date: Date = new Date()): string {
  const h = date.getHours();
  if (h < 5) return '늦은 밤이에요';
  if (h < 12) return '좋은 아침이에요';
  if (h < 18) return '좋은 오후예요';
  return '좋은 저녁이에요';
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
  const prefill = useAppStore((s) => (s.composerPrefill?.target === 'draft' ? s.composerPrefill : null));
  const clearPrefill = useCallback(() => useAppStore.getState().clearComposerPrefill(), []);

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
  const setAgent = useCallback((agent: DraftState['agent']) => onDraftChange({ agent }), [onDraftChange]);

  return (
    <div className="hc-draft" data-testid="draft">
      <div className="hc-draft__hero">
        <div className="hc-draft__mark" aria-hidden>
          <BrandMark size={52} />
        </div>
        <p className="hc-draft__greeting">{greeting()}</p>
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
        prefill={prefill}
        onPrefillApplied={clearPrefill}
        leading={
          <>
            <AgentChip value={draft.agent} onChange={setAgent} />
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
      {/* Reserved line so the alert never shifts the composer. */}
      <div className="hc-draft__hint" role={needFolder ? 'alert' : undefined}>
        {needFolder ? '먼저 작업할 폴더를 선택하세요' : null}
      </div>
      <ul className="hc-suggest" aria-label="추천 프롬프트">
        {SUGGESTED_PROMPTS.map((p, i) => (
          <li key={p.key} style={{ ['--hc-i' as string]: i }}>
            <button
              type="button"
              className="hc-suggest__card"
              data-testid="suggestion"
              onClick={() => composerRef.current?.setText(p.text)}
            >
              <span className="hc-suggest__icon" aria-hidden>
                {SUGGESTION_ICON[p.icon]}
              </span>
              <span className="hc-suggest__title">{p.title}</span>
              <span className="hc-suggest__text">{p.text}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
