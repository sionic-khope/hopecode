import { memo, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { IconSpark } from './icons';
import { useLanguage } from '../../i18n';
import { formatNumber, t } from '../../../shared/i18n';

export interface InlinePromptPlace {
  /** px inside the editor pane. */
  top: number;
  left: number;
  /** Shown under the selection, or over it when there is no room below. */
  side: 'below' | 'above';
}

export interface NoteInlinePromptProps {
  place: InlinePromptPlace;
  /** Writing at the caret (no selection). */
  atCaret: boolean;
  agentLabel: string;
  /** Characters streamed so far while the answer comes in (null = not running). */
  running: number | null;
  error: string | null;
  onSubmit: (text: string) => void;
  onStop: () => void;
  onClose: () => void;
  /** ⌫ in the empty box: the selection itself goes (the prompt closes). */
  onDeleteSelection: () => void;
}

/** The small floating prompt over an editor selection: "선택한 부분을 어떻게 고칠까요?" — Enter sends, Esc closes. */
export const NoteInlinePrompt = memo(function NoteInlinePrompt({ place, atCaret, agentLabel, running, error, onSubmit, onStop, onClose, onDeleteSelection }: NoteInlinePromptProps) {
  useLanguage();
  const [text, setText] = useState('');
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (running === null) input.current?.focus();
  }, [running]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      if (text.trim() && running === null) onSubmit(text.trim());
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if ((e.key === 'Backspace' || e.key === 'Delete') && text === '' && !atCaret) {
      e.preventDefault();
      onDeleteSelection();
    }
  };

  return (
    <div
      className={`hc-noteinline hc-noteinline--${place.side}${running !== null ? ' hc-noteinline--running' : ''}`}
      style={{ top: place.top, left: place.left }}
      role="dialog"
      aria-label={t('noteInline.aria')}
      data-testid="note-inline"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          if (running !== null) onStop();
          else onClose();
        }
      }}
    >
      <div className="hc-noteinline__head">
        <IconSpark className="hc-noteinline__spark" />
        <span className="hc-noteinline__label">{atCaret ? t('noteInline.label.caret') : t('noteInline.label.selection')}</span>
        <span className="hc-noteinline__agent" title={t('noteInline.agentTitle')}>
          {agentLabel}
        </span>
      </div>
      {running !== null ? (
        <div className="hc-noteinline__status" role="status">
          <span className="hc-noteinline__dot" aria-hidden />
          <span>{t('noteInline.running', { count: formatNumber(running) })}</span>
          <button type="button" className="hc-noteinline__stop" onClick={onStop} data-testid="note-inline-stop">
            {t('noteInline.stop')}
          </button>
        </div>
      ) : (
        <div className="hc-noteinline__row">
          <input
            ref={input}
            className="hc-noteinline__input"
            value={text}
            placeholder={atCaret ? t('noteInline.placeholder.caret') : t('noteInline.placeholder.selection')}
            aria-label={atCaret ? t('noteInline.aria.caret') : t('noteInline.aria.selection')}
            data-testid="note-inline-input"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <kbd className="hc-noteinline__kbd" aria-hidden>
            ↵
          </kbd>
        </div>
      )}
      {error ? (
        <div className="hc-noteinline__error" role="alert">
          {error}
        </div>
      ) : (
        <div className="hc-noteinline__hint" aria-hidden>
          {t('noteInline.footer')}
        </div>
      )}
    </div>
  );
});
