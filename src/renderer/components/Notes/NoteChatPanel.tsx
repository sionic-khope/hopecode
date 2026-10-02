import { memo, useCallback, useEffect, useMemo, useRef } from 'react';
import type { CodexEffortLevel, EffortLevel, ModelOption } from '../../../shared/types';
import { NOTE_AGENTS, type NoteAgent, type NoteCardMark, type NoteChatItem } from '../../../shared/notes';
import { parseNoteReply, type NoteCard as NoteCardData } from '../../../core/notes/noteReply';
import { codexModelLabel, concreteModelLabel } from '../../../core/modelDisplay';
import { useAppStore } from '../../store';
import { useNotesStore } from '../../store/notesStore';
import { AssistantText } from '../Chat/AssistantText';
import { Composer, type ComposerHandle } from '../Chat/Composer';
import { AcpModelChip, AgentChip, ModelPicker } from '../Chat/ComposerControls';
import { codexEffortChoices, codexModelChoices, effortValueLabel } from '../Chat/acpChips';
import { NoteCard } from './NoteCard';

const SUGGESTIONS = ['이 주제로 학습 노트 초안을 써 줘', '2번 섹션에 예시를 더 넣어 줘', '전체를 더 짧게 정리해 줘'];

const AGENT_NAME: Record<NoteAgent, string> = { 'claude-code': 'Claude Code', codex: 'Codex' };

/** "Claude Code · Opus" for the agent and model the note requests run with (the inline prompt shows it too). */
export function useNoteAgentLabel(models: readonly ModelOption[], defaultModelLabel: string): string {
  const settings = useAppStore((s) => s.settings);
  const agent = useNotesStore((s) => s.agent);
  const claudeModel = useNotesStore((s) => s.claudeModel) ?? settings.defaultModel;
  const codexModel = useNotesStore((s) => s.codexModel) ?? settings.codexDefaultModel;
  if (agent === 'codex') return `${AGENT_NAME.codex} · ${codexModel ? codexModelLabel(codexModel) : '기본 모델'}`;
  return `${AGENT_NAME['claude-code']} · ${concreteModelLabel(claudeModel || 'default', models, { defaultLabel: defaultModelLabel })}`;
}

export interface NoteChatRun {
  /** The answer streamed so far. */
  text: string;
}

export interface NoteChatPanelProps {
  path: string | null;
  items: NoteChatItem[];
  /** The conversation turn streaming right now (null otherwise). */
  running: NoteChatRun | null;
  /** Any note request (an inline edit included) is running: cards and the composer wait. */
  busy: boolean;
  error: string | null;
  onDismissError: () => void;
  models: ModelOption[];
  defaultModelLabel: string;
  onSend: (text: string) => Promise<boolean>;
  onStop: () => void;
  /** Why a card cannot go into the open note right now (null when it can). */
  cardProblem: (card: NoteCardData) => string | null;
  onApply: (itemId: string, index: number, card: NoteCardData) => void;
  onRevert: (itemId: string, index: number, mark: NoteCardMark) => void;
}

function Reply({
  text,
  streaming,
  itemId,
  marks,
  busy,
  cardProblem,
  onApply,
  onRevert,
}: {
  text: string;
  streaming: boolean;
  itemId: string | null;
  marks?: Record<string, NoteCardMark>;
  busy: boolean;
  cardProblem: NoteChatPanelProps['cardProblem'];
  onApply: NoteChatPanelProps['onApply'];
  onRevert: NoteChatPanelProps['onRevert'];
}) {
  const segments = useMemo(() => parseNoteReply(text, streaming), [text, streaming]);
  return (
    <>
      {segments.map((seg, i) =>
        seg.type === 'text' ? (
          <AssistantText key={`t${i}`} text={seg.text} />
        ) : (
          <NoteCard
            key={`c${seg.index}`}
            card={seg.card}
            mark={marks?.[String(seg.index)]}
            problem={seg.card.complete ? cardProblem(seg.card) : null}
            busy={busy || streaming || itemId === null}
            onApply={() => itemId && onApply(itemId, seg.index, seg.card)}
            onRevert={() => {
              const mark = marks?.[String(seg.index)];
              if (itemId && mark) onRevert(itemId, seg.index, mark);
            }}
          />
        ),
      )}
    </>
  );
}

/** Right half: a free conversation about the open note. Note text comes back as cards the user puts into the editor. */
export const NoteChatPanel = memo(function NoteChatPanel({
  path,
  items,
  running,
  busy,
  error,
  onDismissError,
  models,
  defaultModelLabel,
  onSend,
  onStop,
  cardProblem,
  onApply,
  onRevert,
}: NoteChatPanelProps) {
  const settings = useAppStore((s) => s.settings);
  const localAuth = useAppStore((s) => s.localAuth);
  const threads = useAppStore((s) => s.threads);
  const agent = useNotesStore((s) => s.agent);
  const claudeModel = useNotesStore((s) => s.claudeModel) ?? settings.defaultModel;
  const claudeEffort = useNotesStore((s) => s.claudeEffort) ?? settings.defaultEffort;
  const codexModel = useNotesStore((s) => s.codexModel) ?? settings.codexDefaultModel;
  const codexEffort = useNotesStore((s) => s.codexEffort) ?? settings.codexDefaultEffort;
  const patch = useNotesStore((s) => s.patch);
  const listRef = useRef<HTMLOListElement>(null);
  const composer = useRef<ComposerHandle>(null);

  const codexModels = useMemo(() => (agent === 'codex' ? codexModelChoices(threads, codexModel) : []), [agent, threads, codexModel]);
  const codexEfforts = useMemo(() => (agent === 'codex' ? codexEffortChoices(threads) : []), [agent, threads]);

  // Follow the conversation while it grows (new rows, streamed text).
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items.length, running?.text.length, path]);

  const setAgent = useCallback((next: string) => patch({ agent: next as NoteAgent }), [patch]);
  const recheckAgents = useCallback(() => {
    void useAppStore
      .getState()
      .recheckAgents()
      .catch((err: unknown) => console.error('[deltax] agent recheck failed', err));
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

  const empty = items.length === 0 && !running;

  return (
    <div className="hc-notechat" data-testid="note-chat">
      <ol className="hc-notechat__list" ref={listRef} aria-label="노트 대화" aria-live="polite">
        {empty ? (
          <li className="hc-notechat__empty">
            <p className="hc-notechat__empty-lede">
              {path ? '이 노트에 대해 자유롭게 이야기하세요.' : '노트를 열면 대화할 수 있습니다.'}
            </p>
            <p className="hc-notechat__empty-hint">
              본문에 들어갈 내용은 <b>카드</b>로 받습니다. 카드의 <b>본문에 넣기</b>를 누르면 커서 위치나 해당 섹션에 들어갑니다. 에디터에서 글을 드래그하면 그 부분만 고칠 수 있습니다.
            </p>
            {path ? (
              <div className="hc-notechat__suggest">
                {SUGGESTIONS.map((s) => (
                  <button key={s} type="button" className="hc-notechat__chip" onClick={() => composer.current?.setText(s)}>
                    {s}
                  </button>
                ))}
              </div>
            ) : null}
          </li>
        ) : null}
        {items.map((item) =>
          item.role === 'user' ? (
            <li key={item.id} className="hc-notechat__msg hc-notechat__msg--user" data-testid="note-chat-user">
              {item.text}
            </li>
          ) : (
            <li
              key={item.id}
              className={`hc-notechat__msg hc-notechat__msg--assistant${item.status ? ` hc-notechat__msg--${item.status}` : ''}`}
              data-testid="note-chat-assistant"
            >
              {item.status === 'error' ? (
                <p className="hc-notechat__failed">{item.text}</p>
              ) : (
                <Reply
                  text={item.text}
                  streaming={false}
                  itemId={item.id}
                  marks={item.cards}
                  busy={busy}
                  cardProblem={cardProblem}
                  onApply={onApply}
                  onRevert={onRevert}
                />
              )}
              {item.status === 'stopped' ? <span className="hc-notechat__tag">중지됨</span> : null}
            </li>
          ),
        )}
        {running ? (
          <li className="hc-notechat__msg hc-notechat__msg--assistant hc-notechat__msg--running" data-testid="note-chat-running">
            {running.text.trim() ? (
              <Reply text={running.text} streaming itemId={null} busy cardProblem={cardProblem} onApply={onApply} onRevert={onRevert} />
            ) : (
              <span className="hc-notechat__thinking">
                <span className="hc-notechat__dot" aria-hidden />
                생각 중…
              </span>
            )}
          </li>
        ) : null}
      </ol>
      {error ? (
        <div className="hc-notechat__error" role="alert">
          <span>{error}</span>
          <button type="button" className="hc-notechat__error-close" aria-label="닫기" onClick={onDismissError}>
            ×
          </button>
        </div>
      ) : null}
      <div className="hc-notechat__compose">
        <Composer
          handleRef={composer}
          running={running !== null}
          onInterrupt={onStop}
          disabled={!path || (busy && running === null)}
          onSend={onSend}
          placeholder={path ? '노트에 대해 묻거나, 쓰거나 고쳐 달라고 하세요' : '노트를 먼저 여세요'}
          leading={<AgentChip value={agent} onChange={setAgent} localAuth={localAuth} onRecheck={recheckAgents} agents={NOTE_AGENTS} />}
          trailing={trailing}
        />
      </div>
    </div>
  );
});
