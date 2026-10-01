import { memo, useCallback, useEffect, useMemo, useRef } from 'react';
import type { CodexEffortLevel, EffortLevel, ModelOption } from '../../../shared/types';
import { NOTE_AGENTS, type NoteAgent, type NoteAiMode, type NoteChatItem } from '../../../shared/notes';
import { NOTE_MODE_LABEL } from '../../../core/notes/notePrompt';
import { useAppStore } from '../../store';
import { useNotesStore } from '../../store/notesStore';
import { Segmented } from '../common';
import { Composer } from '../Chat/Composer';
import { AcpModelChip, AgentChip, ModelPicker } from '../Chat/ComposerControls';
import { codexEffortChoices, codexModelChoices, effortValueLabel } from '../Chat/acpChips';

const MODE_OPTIONS = (['write', 'section', 'rewrite'] as const).map((value) => ({
  value,
  label: NOTE_MODE_LABEL[value],
  title:
    value === 'write'
      ? '요청한 주제로 노트를 써서 커서 위치에 넣습니다 (빈 문서는 문서 전체)'
      : value === 'section'
        ? '노란 프레임으로 표시된 섹션(또는 선택 영역)만 고쳐 씁니다'
        : '문서 전체를 다시 씁니다',
}));

const PLACEHOLDER: Record<NoteAiMode, string> = {
  write: '무엇에 대한 노트를 쓸까요? 예: Redis 분산 락과 Redlock',
  section: '노란 프레임 안의 섹션을 어떻게 고칠까요?',
  rewrite: '문서 전체를 어떻게 다시 쓸까요?',
};

export interface NoteRunState {
  mode: NoteAiMode;
  chars: number;
}

export interface NoteChatPanelProps {
  path: string | null;
  items: NoteChatItem[];
  running: NoteRunState | null;
  error: string | null;
  models: ModelOption[];
  defaultModelLabel: string;
  onSend: (text: string) => Promise<boolean>;
  onStop: () => void;
}

/** Right pane: the note's request history (short summaries; the text itself goes into the editor) and the composer. */
export const NoteChatPanel = memo(function NoteChatPanel({ path, items, running, error, models, defaultModelLabel, onSend, onStop }: NoteChatPanelProps) {
  const settings = useAppStore((s) => s.settings);
  const localAuth = useAppStore((s) => s.localAuth);
  const threads = useAppStore((s) => s.threads);
  const aiMode = useNotesStore((s) => s.aiMode);
  const agent = useNotesStore((s) => s.agent);
  const claudeModel = useNotesStore((s) => s.claudeModel) ?? settings.defaultModel;
  const claudeEffort = useNotesStore((s) => s.claudeEffort) ?? settings.defaultEffort;
  const codexModel = useNotesStore((s) => s.codexModel) ?? settings.codexDefaultModel;
  const codexEffort = useNotesStore((s) => s.codexEffort) ?? settings.codexDefaultEffort;
  const patch = useNotesStore((s) => s.patch);
  const listRef = useRef<HTMLOListElement>(null);

  const codexModels = useMemo(() => (agent === 'codex' ? codexModelChoices(threads, codexModel) : []), [agent, threads, codexModel]);
  const codexEfforts = useMemo(() => (agent === 'codex' ? codexEffortChoices(threads) : []), [agent, threads]);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items.length, running]);

  const setAgent = useCallback((next: string) => patch({ agent: next as NoteAgent }), [patch]);
  const recheckAgents = useCallback(() => {
    void useAppStore
      .getState()
      .recheckAgents()
      .catch((err: unknown) => console.error('[hopecode] agent recheck failed', err));
  }, []);

  const trailing =
    agent === 'codex' ? (
      <AcpModelChip
        model={codexModel}
        effort={codexEffort}
        modelLabel={codexModels.find((m) => m.value === codexModel)?.label ?? codexModel}
        effortLabel={codexEffort ? effortValueLabel(codexEffort) : null}
        models={codexModels}
        efforts={codexEfforts}
        onModelChange={(v) => patch({ codexModel: v })}
        onEffortChange={(v) => patch({ codexEffort: v as CodexEffortLevel })}
      />
    ) : (
      <ModelPicker
        models={models}
        model={claudeModel}
        effort={(claudeEffort as EffortLevel | null) ?? null}
        defaultLabel={defaultModelLabel}
        onModelChange={(v) => patch({ claudeModel: v })}
        onEffortChange={(v) => patch({ claudeEffort: v })}
      />
    );

  return (
    <div className="hc-notechat" data-testid="note-chat">
      <div className="hc-notechat__head">
        <span className="hc-notechat__title">노트 도우미</span>
        <span className="hc-notechat__sub">{path ? path : '노트를 열면 요청할 수 있습니다'}</span>
      </div>
      <ol className="hc-notechat__list" ref={listRef} aria-label="요청 기록" aria-live="polite">
        {items.length === 0 && !running ? (
          <li className="hc-notechat__empty">
            주제를 말하면 학습 노트 형식으로 에디터에 바로 써 넣습니다. <b>이 섹션</b>은 커서가 있는 heading 섹션만, <b>전체 수정</b>은 문서 전체를 고칩니다.
            모든 변경은 ⌘Z 한 번으로 되돌릴 수 있습니다.
          </li>
        ) : null}
        {items.map((item) => (
          <li
            key={item.id}
            className={`hc-notechat__item hc-notechat__item--${item.role}${item.status ? ` hc-notechat__item--${item.status}` : ''}`}
            data-testid={`note-chat-${item.role}`}
          >
            {item.role === 'user' ? <span className="hc-notechat__mode">{NOTE_MODE_LABEL[item.mode]}</span> : null}
            <span className="hc-notechat__text">{item.text}</span>
          </li>
        ))}
        {running ? (
          <li className="hc-notechat__item hc-notechat__item--running" data-testid="note-chat-running">
            <span className="hc-notechat__dot" aria-hidden />
            {NOTE_MODE_LABEL[running.mode]} 중… {running.chars.toLocaleString('ko-KR')}자
          </li>
        ) : null}
      </ol>
      {error ? (
        <div className="hc-notechat__error" role="alert">
          {error}
        </div>
      ) : null}
      <div className="hc-notechat__compose">
        <Segmented
          options={MODE_OPTIONS}
          value={aiMode}
          onChange={(v) => patch({ aiMode: v })}
          size="sm"
          aria-label="요청 범위"
          className="hc-notechat__modes"
        />
        <Composer
          running={running !== null}
          onInterrupt={onStop}
          disabled={!path}
          onSend={onSend}
          placeholder={path ? PLACEHOLDER[aiMode] : '왼쪽에서 노트를 먼저 여세요'}
          leading={<AgentChip value={agent} onChange={setAgent} localAuth={localAuth} onRecheck={recheckAgents} agents={NOTE_AGENTS} />}
          trailing={trailing}
        />
      </div>
    </div>
  );
});
