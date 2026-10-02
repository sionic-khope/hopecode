// Light git support for a vault that is its own git repository: changed `.md` files and a commit of exactly those
// files. Never pushes. Runs git through execFile (gitService.run) with the login-shell env.
// A vault is a folder the user picked, possibly someone else's checkout: before any git process runs, its `.git` must
// be a real folder (no link, no gitfile) owned by the user with an owned `config`, and the repository top level must
// be the vault itself (a repository above the vault is never used). The handlers run git only for vaults the user
// turned git on for (settings.noteGitVaults). Every call: fsmonitor off, no optional locks, literal pathspecs, a
// timeout. Status / rev-parse / config also skip hooks and blank every configured filter driver (a `.gitattributes`
// filter would otherwise run a command from the repository config); a commit keeps hooks and filters (user-trusted).
import { lstat, realpath } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import type { GitActionResult } from '../../shared/types';
import type { NoteGitStatus } from '../../shared/notes';
import { isHiddenNoteName, isMarkdownName } from '../../core/notes/notePaths';
import { isStrictlyInside } from '../containment';
import { run as execGit, shortError, type RunResult } from '../git/gitService';
import { vaultRoot } from './vaultFs';
import { t } from '../../shared/i18n';

const COMMIT_MESSAGE_MAX = 5_000;
export const NOTE_GIT_TIMEOUT_MS = 15_000;

/** Options of every git call (before the subcommand). */
export const NOTE_GIT_BASE_ARGS: readonly string[] = [
  '-c',
  'core.quotepath=off',
  '-c',
  'core.fsmonitor=false',
  '--no-optional-locks',
  '--literal-pathspecs',
];

/** Extra options of the calls the app makes on its own (status, rev-parse, config): no hooks. */
const PASSIVE_ARGS: readonly string[] = ['-c', 'core.hooksPath=/dev/null'];

/** A filter driver name usable in a `-c filter.<name>.<key>=` override. */
const FILTER_NAME = /^[A-Za-z0-9._-]{1,100}$/;

interface ChangedFile {
  /** Path relative to the repository top level (= the vault). */
  top: string;
  /** Path relative to the vault. */
  vault: string;
}

export type GitRunner = (cmd: string, args: string[], cwd: string, env: Record<string, string> | undefined, timeout?: number) => Promise<RunResult>;

export interface NoteGit {
  /** The vault has its own, user-owned `.git` folder (file checks only; no git process). */
  detect(vault: string): Promise<boolean>;
  status(vault: string): Promise<Omit<NoteGitStatus, 'enabled'>>;
  commit(vault: string, message: string): Promise<GitActionResult<{ sha: string; files: number }>>;
}

/** `.git` of the vault root: a real folder (not a link / gitfile) owned by the user, its `config` too. */
export async function ownGitDir(root: string): Promise<boolean> {
  const uid = process.getuid?.();
  const owned = (st: { uid: number }) => uid === undefined || st.uid === uid;
  const dir = await lstat(join(root, '.git')).catch(() => null);
  if (!dir || !dir.isDirectory() || !owned(dir)) return false;
  const config = await lstat(join(root, '.git', 'config')).catch(() => null);
  return config === null || (config.isFile() && owned(config));
}

export function createNoteGit(env: () => Record<string, string>, exec: GitRunner = execGit): NoteGit {
  const git = (args: readonly string[], root: string) =>
    // The ceiling keeps discovery from walking above the vault, whatever `.git` holds.
    exec('git', [...NOTE_GIT_BASE_ARGS, ...args], root, { ...env(), GIT_CEILING_DIRECTORIES: dirname(root) }, NOTE_GIT_TIMEOUT_MS);

  /** `-c` overrides that blank every filter driver the repository / user config defines. */
  async function noFilters(root: string): Promise<string[]> {
    const res = await git([...PASSIVE_ARGS, 'config', '--name-only', '--get-regexp', '^filter\\.'], root);
    // Exit 1 = no filter configured.
    if (!res.ok && res.code !== 1) return [];
    const names = new Set<string>();
    for (const key of res.stdout.split('\n')) {
      const m = /^filter\.(.+)\.[^.]+$/.exec(key.trim());
      if (m && FILTER_NAME.test(m[1])) names.add(m[1]);
    }
    return [...names].flatMap((n) => ['-c', `filter.${n}.clean=`, '-c', `filter.${n}.smudge=`, '-c', `filter.${n}.process=`, '-c', `filter.${n}.required=false`]);
  }

  async function scan(vault: string): Promise<{ root: string; files: ChangedFile[] } | null> {
    const root = await vaultRoot(vault);
    if (!(await ownGitDir(root))) return null;
    const topRes = await git([...PASSIVE_ARGS, 'rev-parse', '--show-toplevel'], root);
    if (!topRes.ok) return null;
    // Only the vault's own repository: a repository above (or beside) it turns git off.
    const top = await realpath(topRes.stdout.trim()).catch(() => null);
    if (top !== root) return null;
    const passive = [...PASSIVE_ARGS, ...(await noFilters(root))];
    const res = await git([...passive, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.'], root);
    if (!res.ok) return null;
    const parts = res.stdout.split('\0');
    const files: ChangedFile[] = [];
    const add = (topRel: string) => {
      const abs = join(root, topRel);
      if (!isStrictlyInside(root, abs)) return;
      const vaultRel = relative(root, abs).split(sep).join('/');
      if (!isMarkdownName(vaultRel) || vaultRel.split('/').some(isHiddenNoteName)) return;
      if (!files.some((f) => f.top === topRel)) files.push({ top: topRel, vault: vaultRel });
    };
    for (let i = 0; i < parts.length; i++) {
      const entry = parts[i];
      if (entry.length < 4) continue;
      const code = entry.slice(0, 2);
      add(entry.slice(3));
      // Renames / copies carry the source path as the next field.
      if (code[0] === 'R' || code[0] === 'C') {
        const source = parts[++i];
        if (source) add(source);
      }
    }
    return { root, files };
  }

  return {
    async detect(vault) {
      return ownGitDir(await vaultRoot(vault));
    },

    async status(vault) {
      const found = await scan(vault);
      return found ? { isRepo: true, changed: found.files.map((f) => f.vault) } : { isRepo: false, changed: [] };
    },

    async commit(vault, message) {
      const text = message.trim();
      if (!text) return { ok: false, error: t('git.enterCommitMessage') };
      if (text.length > COMMIT_MESSAGE_MAX) return { ok: false, error: t('noteGit.messageTooLong') };
      const found = await scan(vault);
      if (!found) return { ok: false, error: t('noteGit.notOwnRepo') };
      if (found.files.length === 0) return { ok: false, error: t('noteGit.nothingToCommit') };
      const paths = found.files.map((f) => f.top);
      const add = await git(['add', '-A', '--', ...paths], found.root);
      if (!add.ok) return { ok: false, error: t('git.commitFailed', { error: shortError(add.stderr) }) };
      // `--only` with paths: whatever else was staged in the repository stays out of this commit.
      const res = await git(['commit', '-q', '-m', text, '--only', '--', ...paths], found.root);
      if (!res.ok) return { ok: false, error: t('git.commitFailed', { error: shortError(res.stderr || res.stdout) }) };
      const sha = await git([...PASSIVE_ARGS, 'rev-parse', 'HEAD'], found.root);
      return { ok: true, sha: sha.stdout.trim(), files: paths.length };
    },
  };
}
