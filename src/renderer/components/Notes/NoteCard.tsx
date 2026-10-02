import { memo, useState } from 'react';
import type { NoteCardMark } from '../../../shared/notes';
import { cardTargetLabel, cardTitle, type NoteCard as NoteCardData } from '../../../core/notes/noteReply';
import { Button } from '../common';
import { AssistantText } from '../Chat/AssistantText';
import { useLanguage } from '../../i18n';
import { t, type MessageKey } from '../../../shared/i18n';

/** Lines of a card shown before "펼치기". */
const PREVIEW_LINES = 6;

const KIND_TAG: Record<NoteCardData['kind'], MessageKey> = {
  insert: 'noteCard.kind.insert',
  replace: 'noteCard.kind.replace',
  'replace-all': 'noteCard.kind.replaceAll',
};

export interface NoteCardProps {
  card: NoteCardData;
  mark?: NoteCardMark;
  /** Why the card cannot go in right now (its section is missing, …); null when it can. */
  problem: string | null;
  /** Another request is running or the answer is still streaming: the buttons wait. */
  busy: boolean;
  onApply: () => void;
  onRevert: () => void;
}

/** A piece of note text from the conversation: what it is, where it goes, a preview, and "본문에 넣기". */
export const NoteCard = memo(function NoteCard({ card, mark, problem, busy, onApply, onRevert }: NoteCardProps) {
  useLanguage();
  const [open, setOpen] = useState(false);
  const lines = card.body.split('\n');
  const long = lines.length > PREVIEW_LINES;
  const applied = mark?.state === 'applied';
  const canRevert = applied && mark?.inserted !== undefined;
  const blocked = !applied && problem !== null && card.complete;
  const cls = ['hc-notecard', applied ? 'hc-notecard--applied' : '', blocked ? 'hc-notecard--blocked' : '', card.complete ? '' : 'hc-notecard--streaming']
    .filter(Boolean)
    .join(' ');

  return (
    <article className={cls} data-testid="note-card" data-kind={card.kind} aria-label={t('noteCard.aria', { title: cardTitle(card) })}>
      <header className="hc-notecard__head">
        <span className="hc-notecard__kind">{t(KIND_TAG[card.kind])}</span>
        <span className="hc-notecard__title">{cardTitle(card)}</span>
      </header>
      <div className="hc-notecard__target" data-testid="note-card-target">
        <span aria-hidden>→</span> {cardTargetLabel(card)}
      </div>
      <div className={`hc-notecard__preview${open ? ' hc-notecard__preview--open' : ''}${long && !open ? ' hc-notecard__preview--clipped' : ''}`}>
        {open ? <AssistantText text={card.body} /> : <pre className="hc-notecard__raw">{lines.slice(0, PREVIEW_LINES).join('\n')}</pre>}
      </div>
      <footer className="hc-notecard__foot">
        {long ? (
          <button type="button" className="hc-notecard__toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            {open ? t('more.collapse') : `${t('noteCard.expand')} · ${t('code.lines', { count: lines.length })}`}
          </button>
        ) : null}
        <span className="hc-notecard__spacer" />
        {!card.complete ? (
          <span className="hc-notecard__wait">
            <span className="hc-notecard__dot" aria-hidden />
            {t('noteCard.writing')}
          </span>
        ) : applied ? (
          <>
            <span className="hc-notecard__state" data-testid="note-card-state">
              {t('noteCard.applied')}
            </span>
            {canRevert ? (
              <Button size="sm" onClick={onRevert} disabled={busy} data-testid="note-card-revert" data-sfx="back">
                {t('noteCard.revert')}
              </Button>
            ) : null}
          </>
        ) : (
          <>
            {problem ? (
              <span className="hc-notecard__problem" role="alert" data-testid="note-card-error">
                {problem}
              </span>
            ) : null}
            <Button variant="primary" size="sm" onClick={onApply} disabled={busy || problem !== null} data-testid="note-card-apply">
              {t('noteCard.apply')}
            </Button>
          </>
        )}
      </footer>
    </article>
  );
});
