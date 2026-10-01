import { memo, useEffect, useRef, useState } from 'react';
import type { AgentKind, SystemNoticeItem } from '../../../shared/types';
import { AGENTS } from '../../../shared/agents';
import { copyText } from '../../clipboard';
import { Collapse } from '../common';
import { GlyphCheck, GlyphCopy, GlyphEditResend } from '../common/glyphs';
import { ChevronIcon, PlusIcon } from './icons';
import { describeAgentError, type AgentWarning } from './agentIssues';
import { playSfx } from '../../sound/engine';
import './Chat.css';

/** What the card can do for the turn it ended (only the latest error of a thread gets these). */
export interface ErrorCardActions {
  /** Re-sends the last user message in this thread. */
  onRetry: () => void;
  /** Starts a new thread (same agent / folder / settings) with the last user message. */
  onRetryInNewSession: () => void;
  /** The last user message ("메시지 복사"). */
  message: string;
  /** A turn is running again: the retry buttons wait. */
  disabled?: boolean;
}

export interface ErrorCardProps {
  item: SystemNoticeItem;
  agent: AgentKind;
  actions?: ErrorCardActions | null;
}

function TriangleIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M7.13 2.5a1 1 0 0 1 1.74 0l5.5 9.75a1 1 0 0 1-.87 1.5H2.5a1 1 0 0 1-.87-1.5l5.5-9.75Z" />
      <path d="M8 6.2v3.1" />
      <circle cx="8" cy="11.4" r="0.2" fill="currentColor" />
    </svg>
  );
}

/** Copy action with a short "복사됨" confirmation (text button, unlike the icon-only CopyButton). */
function CopyTextButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <button
      type="button"
      className={`hc-btn hc-btn--plain hc-btn--sm hc-error-card__btn${copied ? ' hc-error-card__btn--done' : ''}`}
      onClick={() => {
        void copyText(text).then((ok) => {
          if (!ok) return;
          setCopied(true);
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => setCopied(false), 1400);
        });
      }}
    >
      {copied ? <GlyphCheck width={13} height={13} /> : <GlyphCopy width={13} height={13} />}
      {copied ? '복사됨' : label}
    </button>
  );
}

/** An error card younger than this plays the error cue when it appears (older ones are history, silent). */
const ERROR_SFX_FRESH_MS = 5000;
const errorSfxPlayed = new Set<string>();

/**
 * A failed turn: icon, a plain-language title and explanation of the (already redacted) error, the raw message
 * behind 자세히 보기, and the ways forward: 다시 시도, 새 세션으로 시도, 메시지 복사.
 */
export const ErrorCard = memo(function ErrorCard({ item, agent, actions }: ErrorCardProps) {
  const [open, setOpen] = useState(false);
  const copy = describeAgentError(item.text, AGENTS[agent].name);
  useEffect(() => {
    if (errorSfxPlayed.has(item.id) || Date.now() - item.createdAt > ERROR_SFX_FRESH_MS) return;
    errorSfxPlayed.add(item.id);
    playSfx('error');
  }, [item.id, item.createdAt]);
  return (
    <section className="hc-error-card" role="status" aria-label={copy.title} data-testid="error-card" data-kind={copy.kind}>
      <div className="hc-error-card__head">
        <span className="hc-error-card__icon">
          <TriangleIcon />
        </span>
        <div className="hc-error-card__text">
          <h3 className="hc-error-card__title">{copy.title}</h3>
          <p className="hc-error-card__desc">{copy.description}</p>
        </div>
      </div>
      <button type="button" className="hc-error-card__toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className={`hc-error-card__chevron${open ? ' hc-error-card__chevron--open' : ''}`}>
          <ChevronIcon width={12} height={12} />
        </span>
        {open ? '자세히 접기' : '자세히 보기'}
      </button>
      <Collapse open={open}>
        <div className="hc-error-card__detail">
          <pre className="hc-error-card__raw" data-testid="error-raw">
            {item.text}
          </pre>
          <CopyTextButton text={item.text} label="오류 내용 복사" />
        </div>
      </Collapse>
      {actions ? (
        <div className="hc-error-card__actions">
          <button type="button" className="hc-btn hc-btn--secondary hc-btn--sm hc-error-card__btn" disabled={actions.disabled} onClick={actions.onRetry}>
            <GlyphEditResend width={13} height={13} />
            다시 시도
          </button>
          <button
            type="button"
            className="hc-btn hc-btn--plain hc-btn--sm hc-error-card__btn"
            disabled={actions.disabled}
            onClick={actions.onRetryInNewSession}
          >
            <PlusIcon width={13} height={13} />
            새 세션으로 시도
          </button>
          <CopyTextButton text={actions.message} label="메시지 복사" />
        </div>
      ) : null}
    </section>
  );
});

/** An agent's warning line that arrived in the answer stream, shown as a warn notice with the agent's own text. */
export function AgentWarningNotice({ warning }: { warning: AgentWarning }) {
  return (
    <div className="hc-notice hc-notice--warn hc-agent-warning" role="status" data-testid="agent-warning">
      <span className="hc-notice__icon">
        <TriangleIcon size={13} />
      </span>
      <span className="hc-agent-warning__text">
        <span>{warning.text}</span>
        <span className="hc-agent-warning__raw">{warning.raw}</span>
      </span>
    </div>
  );
}
