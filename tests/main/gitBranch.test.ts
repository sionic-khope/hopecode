import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitService } from '../../src/main/git/gitService';
import { createFixturePublisher } from '../../src/main/fixtures/fixtureGit';

let root: string;
let env: Record<string, string>;

function git(args: string[], cwd: string): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd, env }).toString().trim();
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'hopecode-branch-')));
  const home = join(root, 'home');
  await mkdir(home);
  env = { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: home, GIT_CONFIG_NOSYSTEM: '1' };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function worktree(): Promise<{ project: string; wt: string }> {
  const project = join(root, 'repo');
  await mkdir(project);
  git(['init', '-q', '-b', 'main'], project);
  await writeFile(join(project, 'a.txt'), 'a\n');
  git(['add', '-A'], project);
  git(['commit', '-q', '-m', 'init'], project);
  const wt = join(root, 'wt');
  git(['worktree', 'add', '-q', '-b', 'hopecode/abc', wt], project);
  return { project, wt };
}

const service = () => createGitService({ env: () => env, publisher: createFixturePublisher() });

describe('gitService.createBranch', () => {
  it('switches the worktree to a new branch, keeping uncommitted work', async () => {
    const { project, wt } = await worktree();
    await writeFile(join(wt, 'a.txt'), 'changed\n');
    expect(await service().createBranch(wt, 'feature/login')).toEqual({ ok: true, branch: 'feature/login' });
    expect(git(['symbolic-ref', '--short', 'HEAD'], wt)).toBe('feature/login');
    expect(git(['status', '--porcelain'], wt)).toBe('M a.txt');
    // The project folder's branch is untouched.
    expect(git(['symbolic-ref', '--short', 'HEAD'], project)).toBe('main');
  });

  it('refuses invalid and existing names without touching the repo', async () => {
    const { wt } = await worktree();
    for (const name of ['-b', 'a..b', 'with space', 'x.lock', '']) {
      const res = await service().createBranch(wt, name);
      expect(res.ok, name).toBe(false);
    }
    const dup = await service().createBranch(wt, 'main');
    expect(dup).toEqual({ ok: false, error: '이미 있는 브랜치입니다: main' });
    expect(git(['symbolic-ref', '--short', 'HEAD'], wt)).toBe('hopecode/abc');
  });

  it('refuses a folder that is not a repository', async () => {
    const plain = join(root, 'plain');
    await mkdir(plain);
    expect(await service().createBranch(plain, 'x')).toEqual({ ok: false, error: 'git 저장소가 아닙니다' });
  });
});
