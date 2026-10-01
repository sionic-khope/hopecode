// Per-thread folders of chats without a project (plan 2.12): `<scratchDir()>/<threadId>`, 0700, never a git repo.
import { chmodSync, lstatSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { assertInside } from '../containment';
import { assertSafeId } from '../persistence/safeId';
import { scratchDir } from '../paths';

function threadDir(threadId: string): string {
  return join(scratchDir(), assertSafeId(threadId, 'scratch thread id'));
}

/** The scratch root must be a real directory: a symlink there would move every scratch folder (and its rm) elsewhere. */
function assertPlainRoot(root: string): void {
  let st;
  try {
    st = lstatSync(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`scratch root is not a plain directory: ${root}`);
}

/** Value for `GIT_CEILING_DIRECTORIES`: git never searches for a repository above (or at) the scratch root. */
export function scratchGitCeiling(): string {
  return scratchDir();
}

/** Creates `<scratchRoot>/<threadId>` (root and folder 0700, no git init) and returns its path. */
export function createScratchDir(threadId: string): string {
  const dir = threadDir(threadId);
  const root = scratchDir();
  assertPlainRoot(root);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    if (!lstatSync(dir).isDirectory()) throw new Error(`scratch path is not a plain directory: ${dir}`);
  }
  chmodSync(dir, 0o700);
  return dir;
}

/** Removes `<scratchRoot>/<threadId>`; false when absent. Refuses a symlink or anything outside the root. */
export function removeScratchDir(threadId: string): boolean {
  const dir = threadDir(threadId);
  assertPlainRoot(scratchDir());
  assertInside(scratchDir(), dir, 'scratch folder');
  let isDir: boolean;
  try {
    const st = lstatSync(dir);
    if (st.isSymbolicLink()) throw new Error(`refusing to delete symlink in scratch root: ${dir}`);
    isDir = st.isDirectory();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
  if (!isDir) throw new Error(`scratch path is not a directory: ${dir}`);
  rmSync(dir, { recursive: true, force: true });
  return true;
}
