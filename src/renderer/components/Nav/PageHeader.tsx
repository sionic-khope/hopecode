import type { ReactNode } from 'react';
import { Button } from '../common';
import './NavPages.css';

/** Back button, display title, one-line lede and optional actions: the header of every nav page. */
export function PageHeader({ title, lede, onBack, actions }: { title: string; lede: string; onBack: () => void; actions?: ReactNode }) {
  return (
    <header className="hc-page__header">
      <Button variant="plain" size="sm" icon aria-label="뒤로" onClick={onBack}>
        <svg width={13} height={13} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M10 3.5 5 8l5 4.5" />
        </svg>
      </Button>
      <div className="hc-page__heading">
        <h1 className="hc-page__title">{title}</h1>
        <p className="hc-page__lede">{lede}</p>
      </div>
      {actions ? <div className="hc-page__actions">{actions}</div> : null}
    </header>
  );
}

export function PageSection({ title, meta, children }: { title: string; meta?: ReactNode; children: ReactNode }) {
  return (
    <section className="hc-page__section" aria-label={title}>
      <div className="hc-page__section-head">
        <h2 className="hc-page__section-title">{title}</h2>
        {meta ? <span className="hc-page__section-meta">{meta}</span> : null}
      </div>
      {children}
    </section>
  );
}
