import { useCallback, useEffect, useState } from 'react';
import { formatRelativeTime } from '../../../core/format';
import type { PrCheckState, PrReviewState, PullRequestInfo, PullRequestList } from '../../../shared/nav';
import type { Project, Thread } from '../../../shared/types';
import { invoke } from '../../api';
import { ipcErrorMessage } from '../../errors';
import { Button, Pill, type PillTone } from '../common';
import { GlyphRefresh } from '../common/glyphs';
import { PageHeader, PageSection } from './PageHeader';

export interface PullRequestsPageProps {
  threads: Thread[];
  projects: Project[];
  onBack: () => void;
  onOpenThread: (threadId: string) => void;
  /** Draft in `projectId` whose worktree starts from the PR's branch. */
  onNewChatFromPr: (projectId: string, pr: PullRequestInfo) => void;
}

const REVIEW: Record<NonNullable<PrReviewState>, { label: string; tone: PillTone }> = {
  approved: { label: '승인됨', tone: 'ok' },
  'changes-requested': { label: '변경 요청', tone: 'crit' },
  'review-required': { label: '리뷰 필요', tone: 'warn' },
};

const CHECKS: Record<NonNullable<PrCheckState>, { label: string; tone: PillTone }> = {
  success: { label: 'CI 통과', tone: 'ok' },
  failure: { label: 'CI 실패', tone: 'crit' },
  pending: { label: 'CI 진행 중', tone: 'warn' },
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
      .catch((err: unknown) => setError(`PR 목록을 가져오지 못했습니다: ${ipcErrorMessage(err)}`))
      .finally(() => setLoading(false));
  }, []);

  // Reload when the set of registered projects changes (a project added from the draft shows up here).
  const projectKey = projects.map((p) => p.id).join(',');
  useEffect(load, [load, projectKey]);

  const openInBrowser = (url: string) => {
    void invoke('prs:openExternal', { url })
      .then((opened) => {
        if (!opened) setError('github.com 주소만 열 수 있습니다');
      })
      .catch((err: unknown) => setError(ipcErrorMessage(err)));
  };

  const linkedThread = (projectId: string, branch: string) =>
    branch.startsWith('hopecode/') ? threads.find((t) => t.projectId === projectId && t.worktree?.branch === branch) : undefined;

  const refresh = (
    <Button size="sm" onClick={load} disabled={loading}>
      <GlyphRefresh width={14} height={14} />
      {loading ? '불러오는 중…' : '새로고침'}
    </Button>
  );

  return (
    <div className="hc-page" data-testid="prs-page">
      <PageHeader title="풀 리퀘스트" lede="등록된 프로젝트의 열린 PR을 모아 봅니다. gh CLI로 가져옵니다." onBack={onBack} actions={refresh} />

      {error ? (
        <div className="hc-page__notice hc-page__notice--error" role="alert">
          {error}
        </div>
      ) : null}

      {list === null ? (
        !error ? <div className="hc-page__notice">불러오는 중…</div> : null
      ) : list.gh === 'missing' ? (
        <div className="hc-page__notice" role="status">
          <strong>gh CLI를 찾을 수 없습니다.</strong> GitHub CLI를 설치한 뒤 새로고침하세요. 예: <code>brew install gh</code>
        </div>
      ) : list.gh === 'unauthenticated' ? (
        <div className="hc-page__notice" role="status">
          <strong>gh에 로그인되어 있지 않습니다.</strong> 터미널에서 <code>gh auth login</code>을 실행한 뒤 새로고침하세요.
        </div>
      ) : list.repos.length === 0 ? (
        <div className="hc-page__notice" role="status">
          remote가 있는 등록된 프로젝트가 없습니다. GitHub에 연결된 저장소 폴더를 프로젝트로 추가하세요.
        </div>
      ) : (
        list.repos.map((repo) => (
          <PageSection key={repo.projectId} title={repo.projectName} meta={repo.repo ?? undefined}>
            <div className="hc-page__card">
              {repo.error ? (
                <div className="hc-page__empty" role="status">
                  <p>PR을 가져오지 못했습니다</p>
                  <p>{repo.error}</p>
                </div>
              ) : repo.prs.length === 0 ? (
                <div className="hc-page__empty">
                  <p>열린 PR이 없습니다</p>
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
                            {pr.review ? <Pill tone={REVIEW[pr.review].tone}>{REVIEW[pr.review].label}</Pill> : null}
                            {pr.checks ? <Pill tone={CHECKS[pr.checks].tone}>{CHECKS[pr.checks].label}</Pill> : null}
                            <span className="hc-page__mono">{pr.branch}</span>
                            {pr.author ? <span>{pr.author}</span> : null}
                            {pr.updatedAt ? <span>{formatRelativeTime(pr.updatedAt, now)}</span> : null}
                          </div>
                          {thread ? (
                            <div className="hc-page__row-sub">
                              <span>연결된 스레드</span>
                              <button type="button" className="hc-page__link" onClick={() => onOpenThread(thread.id)}>
                                {thread.title}
                              </button>
                            </div>
                          ) : null}
                        </div>
                        <div className="hc-page__row-actions">
                          <Button size="sm" variant="plain" onClick={() => openInBrowser(pr.url)}>
                            브라우저에서 열기
                          </Button>
                          <Button size="sm" onClick={() => onNewChatFromPr(repo.projectId, pr)}>
                            이 PR로 새 채팅
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
