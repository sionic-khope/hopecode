// Git worktree per thread (plan 3.2 / 4.2 worktree/worktreeManager.ts).
// Git repo with a HEAD -> `git worktree add -b hopecode/<threadShortId>`; otherwise (non-git
// folder, or a git repo with no commits yet) the project folder is used as-is.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve as resolvePath } from 'node:path';
import { assertInside } from '../containment';
import { worktreesDir } from '../paths';
import type { WorktreeCreateResult, WorktreeManager } from '../contracts';
import type { WorktreeInfo } from '../../shared/types';

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** `remove()` without `force` on a worktree with uncommitted changes (renderer confirms, then retries with force). */
export class WorktreeDirtyError extends Error {
  constructor(path: string) {
    super(`worktree has uncommitted changes: ${path}`);
    this.name = 'WorktreeDirtyError';
  }
}

function runGitIn(args: string[], cwd: string, env: Record<string, string> | undefined): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, ...(env ? { env } : {}) }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout.toString(), stderr: stderr.toString() });
    });
  });
}

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'project';
}

function shortHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 6);
}

export interface WorktreeManagerDeps {
  /** Child env for git (shellEnv.childEnv({})): login-shell PATH, no inherited app env (L6). */
  env?: () => Record<string, string>;
}

export function createWorktreeManager(deps: WorktreeManagerDeps = {}): WorktreeManager {
  const runGit = (args: string[], cwd: string): Promise<GitResult> => runGitIn(args, cwd, deps.env?.());

  async function isDirty(worktreePath: string): Promise<boolean> {
    const status = await runGit(['status', '--porcelain'], worktreePath);
    if (!status.ok) return false;
    return status.stdout.trim().length > 0;
  }

  return {
    async create(projectPath, threadShortId, opts = {}): Promise<WorktreeCreateResult> {
      const toplevel = await runGit(['rev-parse', '--show-toplevel'], projectPath);
      if (!toplevel.ok) return { cwd: projectPath };

      const headCheck = await runGit(['rev-parse', '--verify', 'HEAD'], projectPath);
      if (!headCheck.ok) return { cwd: projectPath };

      const slug = slugify(basename(resolvePath(projectPath)));
      const hash = shortHash(resolvePath(projectPath));
      const dest = join(worktreesDir(), `${slug}-${hash}`, threadShortId);
      await mkdir(dirname(dest), { recursive: true });

      const branch = `hopecode/${threadShortId}`;
      // The checkout must not run repo hooks (post-checkout) of a folder the user has not trusted.
      const noHooks = opts.trusted ? [] : ['-c', 'core.hooksPath=/dev/null'];
      const add = await runGit([...noHooks, 'worktree', 'add', '-b', branch, dest, 'HEAD'], projectPath);
      if (!add.ok) {
        throw new Error(`git worktree add failed: ${add.stderr || add.stdout}`);
      }
      return { cwd: dest, worktree: { path: dest, branch } };
    },

    isDirty,

    async remove(projectPath, worktree: WorktreeInfo, opts) {
      // Only ever touch worktrees Hopecode created (L5).
      assertInside(worktreesDir(), worktree.path, 'worktree');
      if (!opts.force && (await isDirty(worktree.path))) throw new WorktreeDirtyError(worktree.path);
      const args = ['worktree', 'remove', worktree.path];
      if (opts.force) args.push('--force');
      const removed = await runGit(args, projectPath);
      if (!removed.ok) {
        // Worktree metadata may be gone/inconsistent already; fall back to deleting the
        // directory directly and pruning stale git worktree bookkeeping.
        await rm(worktree.path, { recursive: true, force: true });
        await runGit(['worktree', 'prune'], projectPath);
      }
      // The per-thread branch is Hopecode's too (L10); never delete anything else.
      if (worktree.branch.startsWith('hopecode/')) await runGit(['branch', '-D', worktree.branch], projectPath);
    },
  };
}
