import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorktreeDirtyError, createWorktreeManager } from '../../src/main/worktree/worktreeManager';

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd }).toString();
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe('worktreeManager', () => {
  let home: string;
  let previousHome: string | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'hopecode-home-'));
    previousHome = process.env['HOPECODE_HOME'];
    process.env['HOPECODE_HOME'] = home;
  });

  afterEach(async () => {
    if (previousHome === undefined) delete process.env['HOPECODE_HOME'];
    else process.env['HOPECODE_HOME'] = previousHome;
    await rm(home, { recursive: true, force: true });
  });

  it('creates a git worktree when the project has a HEAD commit', async () => {
    const project = await mkdtemp(join(tmpdir(), 'hopecode-project-'));
    try {
      git(['init'], project);
      git(['-c', 'user.email=test@test.com', '-c', 'user.name=test', 'commit', '--allow-empty', '-m', 'init'], project);

      const manager = createWorktreeManager();
      const result = await manager.create(project, 'abc123');

      expect(result.worktree).toBeDefined();
      expect(result.worktree?.branch).toBe('hopecode/abc123');
      expect(result.cwd).toBe(result.worktree?.path);
      expect(result.cwd.startsWith(join(home, 'home', 'worktrees'))).toBe(true);
      expect(await exists(result.cwd)).toBe(true);

      const list = git(['worktree', 'list', '--porcelain'], project);
      expect(list).toContain(result.cwd);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  it('(review 10) repo hooks run on checkout only for a trusted project', async () => {
    const project = await mkdtemp(join(tmpdir(), 'hopecode-hooks-'));
    try {
      git(['init'], project);
      git(['-c', 'user.email=test@test.com', '-c', 'user.name=test', 'commit', '--allow-empty', '-m', 'init'], project);
      await mkdir(join(project, '.git', 'hooks'), { recursive: true });
      const hook = join(project, '.git', 'hooks', 'post-checkout');
      await writeFile(hook, `#!/bin/sh\ntouch "${join(project, 'hook-ran')}-$(basename "$PWD")"\n`);
      await chmod(hook, 0o755);

      const manager = createWorktreeManager();
      await manager.create(project, 'untrust');
      expect(await exists(join(project, 'hook-ran-untrust'))).toBe(false);

      await manager.create(project, 'trusted', { trusted: true });
      expect(await exists(join(project, 'hook-ran-trusted'))).toBe(true);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  it('falls back to the project folder for a non-git directory', async () => {
    const project = await mkdtemp(join(tmpdir(), 'hopecode-plain-'));
    try {
      const manager = createWorktreeManager();
      const result = await manager.create(project, 'shortid');
      expect(result).toEqual({ cwd: project });
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  it('falls back to the project folder for a git repo with no HEAD commit', async () => {
    const project = await mkdtemp(join(tmpdir(), 'hopecode-empty-repo-'));
    try {
      git(['init'], project);
      const manager = createWorktreeManager();
      const result = await manager.create(project, 'shortid');
      expect(result).toEqual({ cwd: project });
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  it('isDirty() reflects uncommitted changes in a worktree', async () => {
    const project = await mkdtemp(join(tmpdir(), 'hopecode-dirty-'));
    try {
      git(['init'], project);
      git(['-c', 'user.email=test@test.com', '-c', 'user.name=test', 'commit', '--allow-empty', '-m', 'init'], project);
      const manager = createWorktreeManager();
      const { worktree } = await manager.create(project, 'dirtyid');
      if (!worktree) throw new Error('expected a worktree');

      expect(await manager.isDirty(worktree.path)).toBe(false);
      await writeFile(join(worktree.path, 'new-file.txt'), 'x');
      expect(await manager.isDirty(worktree.path)).toBe(true);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  it('remove() deletes the worktree directory and its git registration', async () => {
    const project = await mkdtemp(join(tmpdir(), 'hopecode-remove-'));
    try {
      git(['init'], project);
      git(['-c', 'user.email=test@test.com', '-c', 'user.name=test', 'commit', '--allow-empty', '-m', 'init'], project);
      const manager = createWorktreeManager();
      const { worktree } = await manager.create(project, 'removeid');
      if (!worktree) throw new Error('expected a worktree');

      await manager.remove(project, worktree, { force: false });

      expect(await exists(worktree.path)).toBe(false);
      const list = git(['worktree', 'list', '--porcelain'], project);
      expect(list).not.toContain(worktree.path);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  it('(L10) remove() refuses a dirty worktree without force, force removes it and deletes the hopecode branch', async () => {
    const project = await mkdtemp(join(tmpdir(), 'hopecode-remove-dirty-'));
    try {
      git(['init'], project);
      git(['-c', 'user.email=test@test.com', '-c', 'user.name=test', 'commit', '--allow-empty', '-m', 'init'], project);
      const manager = createWorktreeManager({ env: () => ({ ...(process.env as Record<string, string>) }) });
      const { worktree } = await manager.create(project, 'dirtyrm');
      if (!worktree) throw new Error('expected a worktree');
      await writeFile(join(worktree.path, 'wip.txt'), 'unsaved');

      await expect(manager.remove(project, worktree, { force: false })).rejects.toBeInstanceOf(WorktreeDirtyError);
      expect(await exists(join(worktree.path, 'wip.txt'))).toBe(true);

      await manager.remove(project, worktree, { force: true });
      expect(await exists(worktree.path)).toBe(false);
      expect(git(['branch', '--list', 'hopecode/dirtyrm'], project).trim()).toBe('');
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });

  it('(L5) remove() never deletes a path outside the worktrees dir', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'hopecode-outside-'));
    try {
      const manager = createWorktreeManager();
      await expect(manager.remove(outside, { path: outside, branch: 'hopecode/x' }, { force: true })).rejects.toThrow(
        /outside/,
      );
      expect(await exists(outside)).toBe(true);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
