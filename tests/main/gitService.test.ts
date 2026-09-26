import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitService } from '../../src/main/git/gitService';
import { FIXTURE_PR_URL, createFixturePublisher } from '../../src/main/fixtures/fixtureGit';

let root: string;
let env: Record<string, string>;

/** Isolated child env: no global/system git config, identity via env so the service needs no config. */
function makeEnv(home: string): Record<string, string> {
  return {
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  };
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd, env }).toString();
}

async function initRepo(name = 'repo'): Promise<string> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  git(['init', '-q', '-b', 'main'], dir);
  return dir;
}

async function commitAll(dir: string, msg: string): Promise<void> {
  git(['add', '-A'], dir);
  git(['commit', '-q', '-m', msg], dir);
}

/** Repo with a.txt (3 lines), b.txt, c.txt committed on main. */
async function seededRepo(): Promise<string> {
  const dir = await initRepo();
  await writeFile(join(dir, 'a.txt'), 'one\ntwo\nthree\n');
  await writeFile(join(dir, 'b.txt'), 'bee\n');
  await writeFile(join(dir, 'c.txt'), 'rename me\nplease\n');
  await commitAll(dir, 'init');
  return dir;
}

async function addWorktree(project: string, id = 'abc'): Promise<string> {
  const wt = join(root, `wt-${id}`);
  git(['worktree', 'add', '-q', '-b', `hopecode/${id}`, wt], project);
  return wt;
}

function service(publisher = createFixturePublisher()) {
  return createGitService({ env: () => env, publisher });
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'hopecode-git-')));
  const home = join(root, 'home');
  await mkdir(home);
  env = makeEnv(home);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('gitService.changes', () => {
  it('reports a non-repo folder', async () => {
    const dir = join(root, 'plain');
    await mkdir(dir);
    expect(await service().changes(dir, dir)).toEqual({
      isRepo: false,
      branch: null,
      baseBranch: null,
      files: [],
      ahead: 0,
      dirty: false,
    });
  });

  it('lists modified, untracked, deleted and renamed files with counts', async () => {
    const dir = await seededRepo();
    await writeFile(join(dir, 'a.txt'), 'one\nTWO\nthree\nfour\n');
    await unlink(join(dir, 'b.txt'));
    git(['mv', 'c.txt', 'd.txt'], dir);
    await writeFile(join(dir, 'new file.txt'), 'x\ny\n');
    await writeFile(join(dir, 'bin.dat'), Buffer.from([0, 1, 2, 3]));

    const result = await service().changes(dir, dir);
    expect(result.isRepo).toBe(true);
    expect(result.branch).toBe('main');
    expect(result.baseBranch).toBeNull();
    expect(result.ahead).toBe(0);
    expect(result.dirty).toBe(true);
    expect(result.files).toEqual([
      { path: 'a.txt', status: 'M', untracked: false, additions: 2, deletions: 1, binary: false },
      { path: 'b.txt', status: 'D', untracked: false, additions: 0, deletions: 1, binary: false },
      { path: 'bin.dat', status: 'A', untracked: true, additions: 0, deletions: 0, binary: true },
      { path: 'd.txt', oldPath: 'c.txt', status: 'R', untracked: false, additions: 0, deletions: 0, binary: false },
      { path: 'new file.txt', status: 'A', untracked: true, additions: 2, deletions: 0, binary: false },
    ]);
  });

  it('treats everything as added in a repo without commits', async () => {
    const dir = await initRepo();
    await writeFile(join(dir, 'x.txt'), 'hello');
    const result = await service().changes(dir, dir);
    expect(result.branch).toBe('main');
    expect(result.files).toEqual([{ path: 'x.txt', status: 'A', untracked: true, additions: 1, deletions: 0, binary: false }]);
  });

  it('diffs a worktree against the merge-base of the project branch (committed + uncommitted)', async () => {
    const project = await seededRepo();
    const wt = await addWorktree(project);
    await writeFile(join(wt, 'committed.txt'), 'c1\n');
    await commitAll(wt, 'on branch');
    await writeFile(join(wt, 'a.txt'), 'one\ntwo\nthree\nextra\n');
    // Advancing the base branch must not show up as a change in the worktree.
    await writeFile(join(project, 'base-only.txt'), 'b\n');
    await commitAll(project, 'base moves');

    const result = await service().changes(wt, project);
    expect(result.branch).toBe('hopecode/abc');
    expect(result.baseBranch).toBe('main');
    expect(result.ahead).toBe(1);
    expect(result.dirty).toBe(true);
    expect(result.files.map((f) => [f.path, f.status, f.additions])).toEqual([
      ['a.txt', 'M', 1],
      ['committed.txt', 'A', 1],
    ]);
  });
});

describe('gitService.fileDiff', () => {
  it('returns parsed hunks for a tracked file and a synthesized hunk for an untracked one', async () => {
    const dir = await seededRepo();
    await writeFile(join(dir, 'a.txt'), 'one\nTWO\nthree\n');
    await writeFile(join(dir, 'u.txt'), 'l1\nl2');
    const svc = service();

    const tracked = await svc.fileDiff(dir, dir, 'a.txt');
    expect(tracked.binary).toBe(false);
    expect(tracked.hunks).toEqual([{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [' one', '-two', '+TWO', ' three'] }]);

    const untracked = await svc.fileDiff(dir, dir, 'u.txt');
    expect(untracked.hunks).toEqual([
      { oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ['+l1', '+l2', '\\ No newline at end of file'] },
    ]);

    expect((await svc.fileDiff(dir, dir, 'nope.txt')).hunks).toEqual([]);
  });

  it('shows a staged rename against its old name', async () => {
    const dir = await seededRepo();
    git(['mv', 'c.txt', 'd.txt'], dir);
    await writeFile(join(dir, 'd.txt'), 'rename me\nplease\nnow\n');
    const diff = await service().fileDiff(dir, dir, 'd.txt');
    expect(diff.hunks[0].lines).toEqual([' rename me', ' please', '+now']);
  });

  it('rejects paths outside the thread folder', async () => {
    const dir = await seededRepo();
    const svc = service();
    await expect(svc.fileDiff(dir, dir, '../x')).rejects.toThrow();
    await expect(svc.fileDiff(dir, dir, '/etc/passwd')).rejects.toThrow();
    await expect(svc.revertFile(dir, 'sub/../../x')).rejects.toThrow();
    await expect(svc.revertFile(dir, join(dir, 'a.txt'))).rejects.toThrow();
  });
});

describe('gitService.revertFile', () => {
  it('restores modified and deleted files and removes untracked ones', async () => {
    const dir = await seededRepo();
    await writeFile(join(dir, 'a.txt'), 'changed\n');
    await unlink(join(dir, 'b.txt'));
    await writeFile(join(dir, 'u.txt'), 'u\n');
    await writeFile(join(dir, 'staged.txt'), 's\n');
    git(['add', 'staged.txt'], dir);
    const svc = service();

    expect(await svc.revertFile(dir, 'a.txt')).toEqual({ ok: true });
    expect(await readFile(join(dir, 'a.txt'), 'utf8')).toBe('one\ntwo\nthree\n');
    expect(await svc.revertFile(dir, 'b.txt')).toEqual({ ok: true });
    expect(await readFile(join(dir, 'b.txt'), 'utf8')).toBe('bee\n');
    expect(await svc.revertFile(dir, 'u.txt')).toEqual({ ok: true });
    expect(existsSync(join(dir, 'u.txt'))).toBe(false);
    expect(await svc.revertFile(dir, 'staged.txt')).toEqual({ ok: true });
    expect(existsSync(join(dir, 'staged.txt'))).toBe(false);
    expect(git(['status', '--porcelain'], dir)).toBe('');
  });

  it('never deletes an ignored file', async () => {
    const dir = await seededRepo();
    await writeFile(join(dir, '.gitignore'), '.env\n');
    await commitAll(dir, 'ignore');
    await writeFile(join(dir, '.env'), 'SECRET=1\n');
    const result = await service().revertFile(dir, '.env');
    expect(result.ok).toBe(false);
    expect(existsSync(join(dir, '.env'))).toBe(true);
  });
});

describe('gitService.commit', () => {
  it('commits everything, then reports nothing to commit, and rejects an empty message', async () => {
    const dir = await seededRepo();
    await writeFile(join(dir, 'a.txt'), 'new\n');
    await writeFile(join(dir, 'z.txt'), 'z\n');
    const svc = service();

    const ok = await svc.commit(dir, '  update files  ');
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.sha).toBe(git(['rev-parse', 'HEAD'], dir).trim());
    expect(git(['log', '-1', '--format=%s'], dir).trim()).toBe('update files');
    expect(git(['status', '--porcelain'], dir)).toBe('');

    expect(await svc.commit(dir, 'again')).toEqual({ ok: false, error: '커밋할 변경 사항이 없습니다' });
    expect(await svc.commit(dir, '   ')).toEqual({ ok: false, error: '커밋 메시지를 입력하세요' });
  });
});

describe('gitService.merge', () => {
  it('merges the worktree branch into the project branch', async () => {
    const project = await seededRepo();
    const wt = await addWorktree(project);
    await writeFile(join(wt, 'feature.txt'), 'f\n');
    await commitAll(wt, 'feature');

    expect(await service().merge(wt, project)).toEqual({ ok: true, into: 'main' });
    expect(await readFile(join(project, 'feature.txt'), 'utf8')).toBe('f\n');
    // Already merged: still ok.
    expect(await service().merge(wt, project)).toEqual({ ok: true, into: 'main' });
  });

  it('refuses a dirty worktree, a dirty project and a non-worktree folder', async () => {
    const project = await seededRepo();
    const wt = await addWorktree(project);
    const svc = service();
    expect(await svc.merge(project, project)).toEqual({ ok: false, error: 'worktree 스레드가 아닙니다' });

    await writeFile(join(wt, 'x.txt'), 'x\n');
    expect(await svc.merge(wt, project)).toEqual({ ok: false, error: '먼저 변경 사항을 커밋하세요' });
    await commitAll(wt, 'x');

    await writeFile(join(project, 'a.txt'), 'dirty\n');
    expect(await svc.merge(wt, project)).toEqual({ ok: false, error: '원래 브랜치 폴더에 커밋하지 않은 변경 사항이 있습니다' });
  });

  it('aborts a conflicting merge and leaves the project untouched', async () => {
    const project = await seededRepo();
    const wt = await addWorktree(project);
    await writeFile(join(wt, 'a.txt'), 'worktree side\n');
    await commitAll(wt, 'wt edit');
    await writeFile(join(project, 'a.txt'), 'project side\n');
    await commitAll(project, 'project edit');
    const before = git(['rev-parse', 'HEAD'], project);

    const result = await service().merge(wt, project);
    expect(result).toEqual({ ok: false, error: '병합 충돌이 발생해 병합을 취소했습니다: a.txt' });
    expect(git(['rev-parse', 'HEAD'], project)).toBe(before);
    expect(await readFile(join(project, 'a.txt'), 'utf8')).toBe('project side\n');
    expect(existsSync(join(project, '.git', 'MERGE_HEAD'))).toBe(false);
    expect(git(['status', '--porcelain'], project)).toBe('');
  });
});

describe('gitService remote / PR', () => {
  it('reports no remote and refuses to open a PR without one', async () => {
    const dir = await seededRepo();
    const publisher = createFixturePublisher();
    const svc = service(publisher);
    expect(await svc.remoteInfo(dir, dir)).toEqual({ remote: null, remoteUrl: null, branch: 'main', baseBranch: null, ghAvailable: true });
    const result = await svc.pushAndOpenPr(dir, dir, 'title', 'body');
    expect(result.ok).toBe(false);
    expect(publisher.calls).toEqual([]);
  });

  it('pushes the worktree branch and opens a PR against the project branch', async () => {
    const project = await seededRepo();
    const bare = join(root, 'origin.git');
    git(['init', '-q', '--bare', bare], root);
    git(['remote', 'add', 'origin', bare], project);
    const wt = await addWorktree(project);
    await writeFile(join(wt, 'feature.txt'), 'f\n');
    await commitAll(wt, 'feature');
    const publisher = createFixturePublisher();
    const svc = service(publisher);

    expect(await svc.remoteInfo(wt, project)).toEqual({
      remote: 'origin',
      remoteUrl: bare,
      branch: 'hopecode/abc',
      baseBranch: 'main',
      ghAvailable: true,
    });
    expect(await svc.pushAndOpenPr(wt, project, '  ', 'b')).toEqual({ ok: false, error: 'PR 제목을 입력하세요' });

    await writeFile(join(wt, 'dirty.txt'), 'd\n');
    expect(await svc.pushAndOpenPr(wt, project, 'Add feature', 'body')).toEqual({ ok: false, error: '먼저 변경 사항을 커밋하세요' });
    await unlink(join(wt, 'dirty.txt'));

    expect(await svc.pushAndOpenPr(wt, project, 'Add feature', 'body')).toEqual({ ok: true, url: FIXTURE_PR_URL });
    expect(publisher.calls).toEqual([
      { kind: 'push', cwd: wt, remote: 'origin', branch: 'hopecode/abc' },
      { kind: 'createPr', cwd: wt, title: 'Add feature', body: 'body', base: 'main', head: 'hopecode/abc' },
    ]);
  });
});
