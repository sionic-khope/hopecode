import { memo } from 'react';
import type { NoteCardMark } from '../../../shared/notes';
import { cardLines, cardStatus, cardTargetLabel, cardTitle, type NoteCard as NoteCardData, type NoteCardStatus } from '../../../core/notes/noteReply';
import { useLanguage } from '../../i18n';
import { t, type MessageKey } from '../../../shared/i18n';
import { IconNotePage } from './icons';

const STATUS_LABEL: Record<NoteCardStatus, MessageKey> = {
  writing: 'noteCard.writing',
  applied: 'noteCard.applied',
  reverted: 'noteCard.reverted',
  skipped: 'noteCard.skipped',
  unapplied: 'noteCard.unapplied',
};

/** The document a result line opens in the viewer. */
export interface NoteDoc {
  title: string;
  body: string;
}

export interface NoteResultProps {
  card: NoteCardData;
  mark?: NoteCardMark;
  /** The answer is still streaming (a block without a mark is being written right now). */
  streaming: boolean;
  /** Another request is running: 되돌리기 / 보기 wait. */
  busy: boolean;
  onOpenDoc: (doc: NoteDoc) => void;
  onReveal: () => void;
  onRevert: () => void;
}

/**
 * What a note block of an answer did to the note, in one short line: written (보기 jumps to it in the editor,
 * 되돌리기 takes it out), being written, reverted, or not written and why. The block's text opens in the document
 * viewer from its chip; it is never unfolded into the conversation.
 */
export const NoteResult = memo(function NoteResult({ card, mark, streaming, busy, onOpenDoc, onReveal, onRevert }: NoteResultProps) {
  useLanguage();
  const status = cardStatus(mark, streaming);
  const title = cardTitle(card);
  const lines = cardLines(card);
  const canRevert = status === 'applied' && mark?.inserted !== undefined;
  const reason = status === 'skipped' ? mark?.reason : undefined;

  return (
    <article className={`hc-noteresult hc-noteresult--${status}`} data-testid="note-result" data-kind={card.kind} data-status={status} aria-label={t('noteCard.aria', { title })}>
      <div className="hc-noteresult__line">
        <span className="hc-noteresult__mark" aria-hidden />
        <span className="hc-noteresult__status" data-testid="note-result-status">
          {t(STATUS_LABEL[status])}
        </span>
        <span className="hc-noteresult__sep" aria-hidden>
          ·
        </span>
        <span className="hc-noteresult__target" data-testid="note-result-target">
          {cardTargetLabel(card)}
        </span>
        <span className="hc-noteresult__spacer" />
        {status === 'applied' ? (
          <>
            <button type="button" className="hc-noteresult__act" onClick={onReveal} disabled={busy} title={t('noteCard.viewTitle')} data-testid="note-result-view">
              {t('noteCard.view')}
            </button>
            {canRevert ? (
              <button type="button" className="hc-noteresult__act" onClick={onRevert} disabled={busy} data-testid="note-result-revert" data-sfx="back">
                {t('noteCard.revert')}
              </button>
            ) : null}
          </>
        ) : null}
      </div>
      {reason ? (
        <p className="hc-noteresult__reason" role="alert" data-testid="note-result-error">
          {reason}
        </p>
      ) : null}
      <button
        type="button"
        className="hc-notedoc-chip"
        onClick={() => onOpenDoc({ title, body: card.body })}
        disabled={status === 'writing' || card.body === ''}
        aria-label={t('noteCard.openDoc', { title })}
        aria-haspopup="dialog"
        data-testid="note-doc-chip"
      >
        <IconNotePage width={16} height={16} className="hc-notedoc-chip__icon" />
        <span className="hc-notedoc-chip__title">{title}</span>
        <span className="hc-notedoc-chip__meta">{t('code.lines', { count: lines })}</span>
      </button>
    </article>
  );
});
