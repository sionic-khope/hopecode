// Parsing for `gh pr list --json` output and git remote URLs (풀 리퀘스트 page). Pure; main runs gh.
import type { PrCheckState, PrReviewState, PullRequestInfo } from '../shared/nav';

/** Fields requested from `gh pr list --json`. */
export const GH_PR_FIELDS = 'number,title,url,headRefName,baseRefName,author,isDraft,reviewDecision,statusCheckRollup,updatedAt';

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

export function reviewState(decision: unknown): PrReviewState {
  switch (decision) {
    case 'APPROVED':
      return 'approved';
    case 'CHANGES_REQUESTED':
      return 'changes-requested';
    case 'REVIEW_REQUIRED':
      return 'review-required';
    default:
      return null;
  }
}

const FAILED = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);
const PASSED = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);

/**
 * Rolls `statusCheckRollup` (CheckRun: status/conclusion, StatusContext: state) into one state: any failure ->
 * failure, else anything unfinished -> pending, else success; no checks -> null.
 */
export function checkState(rollup: unknown): PrCheckState {
  if (!Array.isArray(rollup) || rollup.length === 0) return null;
  let pending = false;
  for (const entry of rollup) {
    if (!isObj(entry)) continue;
    const verdict = str(entry.conclusion) ?? str(entry.state);
    const status = str(entry.status);
    if (verdict && FAILED.has(verdict)) return 'failure';
    if (status && status !== 'COMPLETED') pending = true;
    else if (!verdict || !PASSED.has(verdict)) pending = true;
  }
  return pending ? 'pending' : 'success';
}

/**
 * `gh pr list --json …` stdout -> PRs. Throws on non-JSON; entries missing a number, title, https URL or head
 * branch are skipped.
 */
export function parseGhPrList(stdout: string): PullRequestInfo[] {
  const raw: unknown = JSON.parse(stdout);
  if (!Array.isArray(raw)) throw new Error('gh pr list did not return a list');
  const out: PullRequestInfo[] = [];
  for (const entry of raw) {
    if (!isObj(entry)) continue;
    const number = entry.number;
    const title = str(entry.title);
    const url = str(entry.url);
    const branch = str(entry.headRefName);
    if (typeof number !== 'number' || !Number.isInteger(number) || number <= 0 || !title || !url || !branch) continue;
    if (!url.startsWith('https://')) continue;
    const updated = str(entry.updatedAt);
    const updatedAt = updated ? Date.parse(updated) : NaN;
    out.push({
      number,
      title,
      url,
      branch,
      baseBranch: str(entry.baseRefName) ?? '',
      author: isObj(entry.author) ? str(entry.author.login) : null,
      draft: entry.isDraft === true,
      review: reviewState(entry.reviewDecision),
      checks: checkState(entry.statusCheckRollup),
      updatedAt: Number.isFinite(updatedAt) ? updatedAt : null,
    });
  }
  return out;
}

/** `owner/repo` of a GitHub remote (https or ssh form); null for other hosts. */
export function githubRepoFromRemote(url: string): string | null {
  const trimmed = url.trim();
  const ssh = /^(?:ssh:\/\/)?git@github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(trimmed);
  if (ssh) return `${ssh[1]}/${ssh[2]}`;
  const https = /^https:\/\/(?:[^@/]+@)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(trimmed);
  if (https) return `${https[1]}/${https[2]}`;
  return null;
}

/** gh's "not logged in" wording (`gh auth login` hint) in stderr. */
export function isGhAuthError(stderr: string): boolean {
  return /gh auth login|not logged in|authentication required|HTTP 401/i.test(stderr);
}

/** A head branch name we are willing to hand to git (check-ref-format subset; never an option). */
export function isSafeBranchName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 255 &&
    !name.startsWith('-') &&
    !name.startsWith('/') &&
    !name.endsWith('/') &&
    !name.endsWith('.lock') &&
    !name.endsWith('.') &&
    !name.includes('..') &&
    !name.includes('@{') &&
    !name.includes('//') &&
    /^[A-Za-z0-9._/-]+$/.test(name)
  );
}
