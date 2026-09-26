// Fixture-mode (`HOPECODE_FIXTURES=1`, e2e) pull request seam: never runs gh or touches the network. Every
// registered project lists the same two PRs, plus one for the first worktree thread's `hopecode/*` branch so the
// thread link shows.
import type { PullRequestInfo } from '../../shared/nav';
import type { Thread } from '../../shared/types';
import type { PrSource } from '../prs/prService';

/** Branch of the fixture PR #42 (e2e creates it in the sandbox repo so "이 PR로 새 채팅" can check it out). */
export const FIXTURE_PR_BRANCH = 'feature/login-polish';

export function createFixturePrSource(listThreads: () => readonly Thread[]): PrSource {
  return {
    async list(projects) {
      const now = Date.now();
      return {
        gh: 'ok',
        fetchedAt: now,
        repos: projects.map((project) => {
          const prs: PullRequestInfo[] = [
            {
              number: 42,
              title: '로그인 화면 문구 정리',
              url: 'https://github.com/example/hopecode-fixture/pull/42',
              branch: FIXTURE_PR_BRANCH,
              baseBranch: 'main',
              author: 'octocat',
              draft: false,
              review: 'approved',
              checks: 'success',
              updatedAt: now - 3_600_000,
            },
            {
              number: 41,
              title: '설정 화면 초안',
              url: 'https://github.com/example/hopecode-fixture/pull/41',
              branch: 'feature/settings-draft',
              baseBranch: 'main',
              author: 'hubot',
              draft: true,
              review: 'review-required',
              checks: 'pending',
              updatedAt: now - 86_400_000,
            },
          ];
          const linked = listThreads().find((t) => t.projectId === project.id && t.worktree?.branch.startsWith('hopecode/'));
          if (linked?.worktree) {
            prs.unshift({
              number: 43,
              title: `${linked.title} (Hopecode)`,
              url: 'https://github.com/example/hopecode-fixture/pull/43',
              branch: linked.worktree.branch,
              baseBranch: 'main',
              author: 'octocat',
              draft: false,
              review: 'changes-requested',
              checks: 'failure',
              updatedAt: now - 600_000,
            });
          }
          return { projectId: project.id, projectName: project.name, repo: 'example/hopecode-fixture', prs, error: null };
        }),
      };
    },
  };
}
