import { describe, expect, it } from 'vitest';
import { checkState, githubRepoFromRemote, isGhAuthError, isSafeBranchName, parseGhPrList, reviewState } from '../../src/core/ghPrs';

const sample = JSON.stringify([
  {
    number: 12,
    title: 'Fix login copy',
    url: 'https://github.com/acme/app/pull/12',
    headRefName: 'fix/login',
    baseRefName: 'main',
    author: { login: 'octocat', is_bot: false },
    isDraft: false,
    reviewDecision: 'APPROVED',
    statusCheckRollup: [
      { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { __typename: 'StatusContext', state: 'SUCCESS' },
    ],
    updatedAt: '2026-09-20T10:00:00Z',
  },
  {
    number: 13,
    title: 'WIP: settings',
    url: 'https://github.com/acme/app/pull/13',
    headRefName: 'hopecode/abcd1234',
    baseRefName: 'main',
    author: null,
    isDraft: true,
    reviewDecision: '',
    statusCheckRollup: [],
    updatedAt: 'not a date',
  },
  { number: 'x', title: 'bad number', url: 'https://github.com/acme/app/pull/0', headRefName: 'b' },
  { number: 14, title: 'no url', headRefName: 'b' },
  { number: 15, title: 'http url', url: 'http://github.com/acme/app/pull/15', headRefName: 'b' },
  'garbage',
]);

describe('parseGhPrList', () => {
  it('maps gh fields and skips malformed entries', () => {
    const prs = parseGhPrList(sample);
    expect(prs.map((p) => p.number)).toEqual([12, 13]);
    expect(prs[0]).toEqual({
      number: 12,
      title: 'Fix login copy',
      url: 'https://github.com/acme/app/pull/12',
      branch: 'fix/login',
      baseBranch: 'main',
      author: 'octocat',
      draft: false,
      review: 'approved',
      checks: 'success',
      updatedAt: Date.parse('2026-09-20T10:00:00Z'),
    });
    expect(prs[1]).toMatchObject({ author: null, draft: true, review: null, checks: null, updatedAt: null });
  });

  it('an empty list parses; non-JSON and non-arrays throw', () => {
    expect(parseGhPrList('[]')).toEqual([]);
    expect(() => parseGhPrList('error: not json')).toThrow();
    expect(() => parseGhPrList('{"a":1}')).toThrow();
  });
});

describe('checkState / reviewState', () => {
  it('any failure wins, then pending, then success', () => {
    expect(checkState([{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { status: 'IN_PROGRESS', conclusion: '' }])).toBe('pending');
    expect(checkState([{ status: 'IN_PROGRESS' }, { status: 'COMPLETED', conclusion: 'FAILURE' }])).toBe('failure');
    expect(checkState([{ state: 'PENDING' }])).toBe('pending');
    expect(checkState([{ state: 'ERROR' }])).toBe('failure');
    expect(checkState([{ status: 'COMPLETED', conclusion: 'SKIPPED' }, { state: 'SUCCESS' }])).toBe('success');
    expect(checkState(null)).toBeNull();
  });

  it('review decisions', () => {
    expect(reviewState('CHANGES_REQUESTED')).toBe('changes-requested');
    expect(reviewState('REVIEW_REQUIRED')).toBe('review-required');
    expect(reviewState(undefined)).toBeNull();
  });
});

describe('githubRepoFromRemote', () => {
  it('https and ssh GitHub remotes', () => {
    expect(githubRepoFromRemote('https://github.com/acme/app.git')).toBe('acme/app');
    expect(githubRepoFromRemote('https://token@github.com/acme/app')).toBe('acme/app');
    expect(githubRepoFromRemote('git@github.com:acme/my.repo.git')).toBe('acme/my.repo');
    expect(githubRepoFromRemote('ssh://git@github.com/acme/app.git')).toBe('acme/app');
    expect(githubRepoFromRemote('https://gitlab.com/acme/app.git')).toBeNull();
  });
});

describe('isGhAuthError / isSafeBranchName', () => {
  it('recognizes gh login errors', () => {
    expect(isGhAuthError('To get started with GitHub CLI, please run:  gh auth login')).toBe(true);
    expect(isGhAuthError('GraphQL: Could not resolve to a Repository')).toBe(false);
  });

  it('branch names safe to hand to git', () => {
    for (const ok of ['main', 'fix/login', 'hopecode/abcd1234', 'release-1.2']) expect(isSafeBranchName(ok)).toBe(true);
    for (const bad of ['', '-rf', '--upload-pack=x', 'a..b', 'a b', 'x.lock', 'a@{1}', '/abs', 'dir/', 'a//b']) {
      expect(isSafeBranchName(bad)).toBe(false);
    }
  });
});
