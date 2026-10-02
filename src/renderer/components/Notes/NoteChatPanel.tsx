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
import { useLanguage } from '../../i18n';
import { t, type MessageKey } from '../../../shared/i18n';
import { tNodes } from '../../i18n';

const SUGGESTIONS: readonly MessageKey[] = ['noteChat.suggest.draft', 'noteChat.suggest.examples', 'noteChat.suggest.shorter'];

const AGENT_NAME: Record<NoteAgent, string> = { 'claude-code': 'Claude Code', codex: 'Codex' };

/** "Claude Code · Opus" for the agent and model the note requests run with (the inline prompt shows it too). */
export function useNoteAgentLabel(models: readonly ModelOption[], defaultModelLabel: string): string {
  const settings = useAppStore((s) => s.settings);
  const agent = useNotesStore((s) => s.agent);
  const claudeModel = useNotesStore((s) => s.claudeModel) ?? settings.defaultModel;
  const codexModel = useNotesStore((s) => s.codexModel) ?? settings.codexDefaultModel;
  if (agent === 'codex') return `${AGENT_NAME.codex} · ${codexModel ? codexModelLabel(codexModel) : t('settings.defaultModel')}`;
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
  useLanguage();
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
      <ol className="hc-notechat__list" ref={listRef} aria-label={t('noteChat.aria')} aria-live="polite">
        {empty ? (
          <li className="hc-notechat__empty">
            <p className="hc-notechat__empty-lede">
              {path ? t('noteChat.empty.withNote') : t('noteChat.empty.noNote')}
            </p>
            <p className="hc-notechat__empty-hint">
              {tNodes('noteChat.hint', { card: <b>{t('noteChat.hint.card')}</b>, apply: <b>{t('noteCard.apply')}</b> })}
            </p>
            {path ? (
              <div className="hc-notechat__suggest">
                {SUGGESTIONS.map((key) => t(key)).map((s) => (
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
              {item.status === 'stopped' ? <span className="hc-notechat__tag">{t('noteChat.stopped')}</span> : null}
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
                {t('noteChat.thinking')}
              </span>
            )}
          </li>
        ) : null}
      </ol>
      {error ? (
        <div className="hc-notechat__error" role="alert">
          <span>{error}</span>
          <button type="button" className="hc-notechat__error-close" aria-label={t('common.close')} onClick={onDismissError}>
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
          placeholder={path ? t('noteChat.placeholder') : t('noteChat.placeholder.noNote')}
          leading={<AgentChip value={agent} onChange={setAgent} localAuth={localAuth} onRecheck={recheckAgents} agents={NOTE_AGENTS} />}
          trailing={trailing}
        />
      </div>
    </div>
  );
});
