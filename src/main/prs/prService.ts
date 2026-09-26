// Open pull requests of the registered projects via the `gh` CLI (풀 리퀘스트 page). Every run is execFile (no
// shell) with the login-shell child env, in a registered project's folder only.
import { execFile } from 'node:child_process';
import { GH_PR_FIELDS, githubRepoFromRemote, isGhAuthError, parseGhPrList } from '../../core/ghPrs';
import type { ProjectPullRequests, PullRequestList } from '../../shared/nav';
import type { Project } from '../../shared/types';

const GH_TIMEOUT_MS = 20_000;
const PR_LIMIT = 50;

export interface PrSource {
  list(projects: readonly Project[]): Promise<PullRequestList>;
}

interface RunResult {
  ok: boolean;
  /** Spawn failed (binary not found). */
  missing: boolean;
  stdout: string;
  stderr: string;
}

type Run = (cmd: string, args: string[], cwd: string) => Promise<RunResult>;

function runner(env: () => Record<string, string>): Run {
  return (cmd, args, cwd) =>
    new Promise((done) => {
      execFile(cmd, args, { cwd, env: env(), timeout: GH_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        const code = (err as { code?: unknown } | null)?.code;
        done({
          ok: !err,
          missing: code === 'ENOENT',
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? '') || (err ? err.message : ''),
        });
      });
    });
}

function shortError(text: string): string {
  return text.trim().split('\n').slice(-2).join(' ').trim() || 'gh 실행에 실패했습니다';
}

/** Remote URL of `origin` (or the first remote); null when the folder is not a repo or has no remote. */
async function remoteUrl(run: Run, cwd: string): Promise<string | null> {
  const remotes = await run('git', ['remote'], cwd);
  if (!remotes.ok) return null;
  const names = remotes.stdout.split('\n').map((r) => r.trim()).filter(Boolean);
  const remote = names.includes('origin') ? 'origin' : names[0];
  if (!remote) return null;
  const url = await run('git', ['remote', 'get-url', remote], cwd);
  return url.ok ? url.stdout.trim() || null : null;
}

export function createGhPrSource(env: () => Record<string, string>, run: Run = runner(env)): PrSource {
  return {
    async list(projects) {
      const fetchedAt = Date.now();
      const version = await run('gh', ['--version'], process.cwd());
      if (!version.ok) return { gh: 'missing', repos: [], fetchedAt };

      const repos: ProjectPullRequests[] = [];
      for (const project of projects) {
        const url = await remoteUrl(run, project.path);
        if (!url) continue;
        const base = { projectId: project.id, projectName: project.name, repo: githubRepoFromRemote(url) };
        const res = await run('gh', ['pr', 'list', '--state', 'open', '--limit', String(PR_LIMIT), '--json', GH_PR_FIELDS], project.path);
        if (!res.ok) {
          if (isGhAuthError(res.stderr)) return { gh: 'unauthenticated', repos: [], fetchedAt };
          repos.push({ ...base, prs: [], error: shortError(res.stderr) });
          continue;
        }
        try {
          repos.push({ ...base, prs: parseGhPrList(res.stdout), error: null });
        } catch (err) {
          repos.push({ ...base, prs: [], error: err instanceof Error ? err.message : String(err) });
        }
      }
      return { gh: 'ok', repos, fetchedAt };
    },
  };
}
