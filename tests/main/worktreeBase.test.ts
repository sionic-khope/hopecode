// "이 PR로 새 채팅": the worktree starts from the PR branch (local, remote-tracking, or fetched from the remote).
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWorktreeManager } from '../../src/main/worktree/worktreeManager';

const git = (args: string[], cwd: string) =>
  execFileSync('git', ['-c', 'user.email=t@t.com', '-c', 'user.name=t', ...args], { cwd }).toString().trim();

describe('worktreeManager base branch', () => {
  let home: string;
  let previousHome: string | undefined;
  const dirs: string[] = [];
  const tmp = async (prefix: string) => {
    const d = await mkdtemp(join(tmpdir(), prefix));
    dirs.push(d);
    return d;
  };

  beforeEach(async () => {
    home = await tmp('hopecode-home-');
    previousHome = process.env['HOPECODE_HOME'];
    process.env['HOPECODE_HOME'] = home;
  });
  afterEach(async () => {
    if (previousHome === undefined) delete process.env['HOPECODE_HOME'];
    else process.env['HOPECODE_HOME'] = previousHome;
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  it('starts from a local branch without switching the project checkout', async () => {
    const project = await tmp('hopecode-pr-');
    git(['init', '-q', '-b', 'main'], project);
    git(['commit', '-q', '--allow-empty', '-m', 'init'], project);
    git(['branch', 'feature/x'], project);
    git(['commit', '-q', '--allow-empty', '-m', 'main moves on'], project);
    const featureSha = git(['rev-parse', 'feature/x'], project);

    const result = await createWorktreeManager().create(project, 'pr1', { base: { branch: 'feature/x' } });
    expect(git(['rev-parse', 'HEAD'], result.cwd)).toBe(featureSha);
    expect(result.worktree?.branch).toBe('hopecode/pr1');
    expect(git(['branch', '--show-current'], project)).toBe('main');
  });

  it('fetches a branch that only exists on the remote, and pull/<n>/head for a fork PR', async () => {
    const upstream = await tmp('hopecode-up-');
    git(['init', '-q', '-b', 'main'], upstream);
    git(['commit', '-q', '--allow-empty', '-m', 'init'], upstream);
    const project = await tmp('hopecode-clone-');
    git(['clone', '-q', upstream, '.'], project);

    git(['checkout', '-q', '-b', 'remote-only'], upstream);
    git(['commit', '-q', '--allow-empty', '-m', 'remote work'], upstream);
    const remoteSha = git(['rev-parse', 'HEAD'], upstream);
    git(['update-ref', 'refs/pull/7/head', remoteSha], upstream);
    git(['checkout', '-q', 'main'], upstream);

    const manager = createWorktreeManager();
    const fetched = await manager.create(project, 'pr2', { base: { branch: 'remote-only' } });
    expect(git(['rev-parse', 'HEAD'], fetched.cwd)).toBe(remoteSha);

    const fork = await manager.create(project, 'pr3', { base: { branch: 'someone/fork-branch', pr: 7 } });
    expect(git(['rev-parse', 'HEAD'], fork.cwd)).toBe(remoteSha);
  });

  it('refuses unsafe branch names and branches that cannot be found', async () => {
    const project = await tmp('hopecode-bad-');
    git(['init', '-q', '-b', 'main'], project);
    git(['commit', '-q', '--allow-empty', '-m', 'init'], project);
    const manager = createWorktreeManager();
    await expect(manager.create(project, 'x1', { base: { branch: '--upload-pack=evil' } })).rejects.toThrow(/invalid branch/);
    await expect(manager.create(project, 'x2', { base: { branch: 'nope' } })).rejects.toThrow(/가져오지 못했습니다/);
  });
});
