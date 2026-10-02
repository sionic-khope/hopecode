import { useCallback, useEffect, useState } from 'react';
import { formatRelativeTime } from '../../../core/format';
import type { PrCheckState, PrReviewState, PullRequestInfo, PullRequestList } from '../../../shared/nav';
import type { Project, Thread } from '../../../shared/types';
import { invoke } from '../../api';
import { ipcErrorMessage } from '../../errors';
import { Button, Pill, type PillTone } from '../common';
import { GlyphRefresh } from '../common/glyphs';
import { PageHeader, PageSection } from './PageHeader';
import { t, type MessageKey } from '../../../shared/i18n';
import { tNodes } from '../../i18n';

export interface PullRequestsPageProps {
  threads: Thread[];
  projects: Project[];
  onBack: () => void;
  onOpenThread: (threadId: string) => void;
  /** Draft in `projectId` whose worktree starts from the PR's branch. */
  onNewChatFromPr: (projectId: string, pr: PullRequestInfo) => void;
}

const REVIEW: Record<NonNullable<PrReviewState>, { label: MessageKey; tone: PillTone }> = {
  approved: { label: 'prs.review.approved', tone: 'ok' },
  'changes-requested': { label: 'prs.review.changes', tone: 'crit' },
  'review-required': { label: 'prs.review.required', tone: 'warn' },
};

const CHECKS: Record<NonNullable<PrCheckState>, { label: MessageKey; tone: PillTone }> = {
  success: { label: 'prs.ci.success', tone: 'ok' },
  failure: { label: 'prs.ci.failure', tone: 'crit' },
  pending: { label: 'prs.ci.pending', tone: 'warn' },
};

/** 풀 리퀘스트: open PRs of every registered project with a remote (gh), grouped by project. */
export function PullRequestsPage({ threads, projects, onBack, onOpenThread, onNewChatFromPr }: PullRequestsPageProps) {
  const [list, setList] = useState<PullRequestList | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const now = Date.now();

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    invoke('prs:list')
      .then(setList)
      .catch((err: unknown) => setError(t('prs.err.list', { error: ipcErrorMessage(err) })))
      .finally(() => setLoading(false));
  }, []);

  // Reload when the set of registered projects changes (a project added from the draft shows up here).
  const projectKey = projects.map((p) => p.id).join(',');
  useEffect(load, [load, projectKey]);

  const openInBrowser = (url: string) => {
    void invoke('prs:openExternal', { url })
      .then((opened) => {
        if (!opened) setError(t('prs.githubOnly'));
      })
      .catch((err: unknown) => setError(ipcErrorMessage(err)));
  };

  const linkedThread = (projectId: string, branch: string) =>
    branch.startsWith('hopecode/') ? threads.find((t) => t.projectId === projectId && t.worktree?.branch === branch) : undefined;

  const refresh = (
    <Button size="sm" onClick={load} disabled={loading}>
      <GlyphRefresh width={14} height={14} />
      {loading ? t('common.loading') : t('prs.refresh')}
    </Button>
  );

  return (
    <div className="hc-page" data-testid="prs-page">
      <PageHeader title={t('nav.prs')} lede={t('prs.lede')} onBack={onBack} actions={refresh} />

      {error ? (
        <div className="hc-page__notice hc-page__notice--error" role="alert">
          {error}
        </div>
      ) : null}

      {list === null ? (
        !error ? <div className="hc-page__notice">{t('common.loading')}</div> : null
      ) : list.gh === 'missing' ? (
        <div className="hc-page__notice" role="status">
          {tNodes('prs.ghMissing', { title: <strong>{t('prs.ghMissing.title')}</strong>, command: <code>brew install gh</code> })}
        </div>
      ) : list.gh === 'unauthenticated' ? (
        <div className="hc-page__notice" role="status">
          {tNodes('prs.ghLogin', { title: <strong>{t('prs.ghLogin.title')}</strong>, command: <code>gh auth login</code> })}
        </div>
      ) : list.repos.length === 0 ? (
        <div className="hc-page__notice" role="status">
          {t('prs.noRemote')}
        </div>
      ) : (
        list.repos.map((repo) => (
          <PageSection key={repo.projectId} title={repo.projectName} meta={repo.repo ?? undefined}>
            <div className="hc-page__card">
              {repo.error ? (
                <div className="hc-page__empty" role="status">
                  <p>{t('prs.fetchFailed')}</p>
                  <p>{repo.error}</p>
                </div>
              ) : repo.prs.length === 0 ? (
                <div className="hc-page__empty">
                  <p>{t('prs.none')}</p>
                </div>
              ) : (
                <ul className="hc-page__list" aria-label={`${repo.projectName} PR`}>
                  {repo.prs.map((pr) => {
                    const thread = linkedThread(repo.projectId, pr.branch);
                    return (
                      <li key={pr.number} className="hc-page__row" data-testid="pr-row">
                        <div className="hc-page__row-main">
                          <div className="hc-page__row-title">
                            <span>{pr.title}</span>
                            <span className="hc-page__num">#{pr.number}</span>
                          </div>
                          <div className="hc-page__row-sub">
                            {pr.draft ? <Pill>Draft</Pill> : <Pill tone="accent">Open</Pill>}
                            {pr.review ? <Pill tone={REVIEW[pr.review].tone}>{t(REVIEW[pr.review].label)}</Pill> : null}
                            {pr.checks ? <Pill tone={CHECKS[pr.checks].tone}>{t(CHECKS[pr.checks].label)}</Pill> : null}
                            <span className="hc-page__mono">{pr.branch}</span>
                            {pr.author ? <span>{pr.author}</span> : null}
                            {pr.updatedAt ? <span>{formatRelativeTime(pr.updatedAt, now)}</span> : null}
                          </div>
                          {thread ? (
                            <div className="hc-page__row-sub">
                              <span>{t('prs.linkedThread')}</span>
                              <button type="button" className="hc-page__link" onClick={() => onOpenThread(thread.id)}>
                                {thread.title}
                              </button>
                            </div>
                          ) : null}
                        </div>
                        <div className="hc-page__row-actions">
                          <Button size="sm" variant="plain" onClick={() => openInBrowser(pr.url)}>
                            {t('prs.openBrowser')}
                          </Button>
                          <Button size="sm" onClick={() => onNewChatFromPr(repo.projectId, pr)}>
                            {t('prs.newChat')}
                          </Button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </PageSection>
        ))
      )}
    </div>
  );
}
