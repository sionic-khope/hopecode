import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CodexEffortLevel, EffortLevel, ModelOption } from '../../../shared/types';
import { NOTE_AGENTS, type NoteAgent, type NoteCardMark, type NoteChatItem } from '../../../shared/notes';
import { parseNoteReply } from '../../../core/notes/noteReply';
import { codexModelLabel, concreteModelLabel } from '../../../core/modelDisplay';
import { useAppStore } from '../../store';
import { useNotesStore } from '../../store/notesStore';
import { AssistantText } from '../Chat/AssistantText';
import { Composer, type ComposerHandle } from '../Chat/Composer';
import { AcpModelChip, AgentChip, ModelPicker } from '../Chat/ComposerControls';
import { codexEffortChoices, codexModelChoices, effortValueLabel } from '../Chat/acpChips';
import { MarkdownCopyChip } from '../Chat/MarkdownCopyChip';
import { NoteDocViewer } from './NoteDocViewer';
import { NoteResult, type NoteDoc } from './NoteResult';
import { useLanguage } from '../../i18n';
import { t, type MessageKey } from '../../../shared/i18n';

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
  /** What became of its note blocks so far (index -> mark), as they were written into the editor. */
  marks: Record<string, NoteCardMark>;
}

export interface NoteChatPanelProps {
  path: string | null;
  items: NoteChatItem[];
  /** The conversation turn streaming right now (null otherwise). */
  running: NoteChatRun | null;
  /** Any note request (an inline edit included) is running: result actions and the composer wait. */
  busy: boolean;
  error: string | null;
  onDismissError: () => void;
  models: ModelOption[];
  defaultModelLabel: string;
  onSend: (text: string) => Promise<boolean>;
  onStop: () => void;
  /** 보기: the editor scrolls to where a written block sits now. */
  onReveal: (mark: NoteCardMark) => void;
  onRevert: (itemId: string, index: number, mark: NoteCardMark) => void;
}

/**
 * One answer: its chat text rendered in full (markdown, as it streams) and, for each note block, a one-line result of
 * what was written into the editor.
 */
function Reply({
  text,
  streaming,
  itemId,
  marks,
  busy,
  onOpenDoc,
  onReveal,
  onRevert,
}: {
  text: string;
  streaming: boolean;
  itemId: string | null;
  marks?: Record<string, NoteCardMark>;
  busy: boolean;
  onOpenDoc: (doc: NoteDoc) => void;
  onReveal: NoteChatPanelProps['onReveal'];
  onRevert: NoteChatPanelProps['onRevert'];
}) {
  const segments = useMemo(() => parseNoteReply(text, streaming), [text, streaming]);
  const last = segments.length - 1;
  return (
    <>
      {segments.map((seg, i) => {
        if (seg.type === 'text') return <AssistantText key={`t${i}`} text={seg.text} streaming={streaming && i === last} />;
        const mark = marks?.[String(seg.index)];
        return (
          <NoteResult
            key={`c${seg.index}`}
            card={seg.card}
            mark={mark}
            streaming={streaming}
            busy={busy || streaming || itemId === null}
            onOpenDoc={onOpenDoc}
            onReveal={() => mark && onReveal(mark)}
            onRevert={() => {
              if (itemId && mark) onRevert(itemId, seg.index, mark);
            }}
          />
        );
      })}
    </>
  );
}

/**
 * Right half: a conversation about the open note. Answers render in full like any chat; text the user asked to be
 * written goes straight into the editor and leaves a result line here. Documents open in a viewer over the pane.
 */
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
  onReveal,
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
  const [doc, setDoc] = useState<NoteDoc | null>(null);
  // Another note, another conversation: its viewer goes.
  useEffect(() => setDoc(null), [path]);

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
            <p className="hc-notechat__empty-hint">{t('noteChat.hint')}</p>
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
              <MarkdownCopyChip getText={() => item.text} label={t('message.copy')} className="hc-notechat__copy" />
              <div className="hc-notechat__bubble">{item.text}</div>
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
                  onOpenDoc={setDoc}
                  onReveal={onReveal}
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
              <Reply text={running.text} streaming itemId={null} marks={running.marks} busy onOpenDoc={setDoc} onReveal={onReveal} onRevert={onRevert} />
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
      {doc ? <NoteDocViewer doc={doc} onClose={() => setDoc(null)} /> : null}
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
