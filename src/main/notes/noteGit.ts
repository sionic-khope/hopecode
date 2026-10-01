// Light git support for a vault that is (inside) a git repository: changed `.md` files and a commit of exactly those
// files. Never pushes. Runs git through execFile (gitService.run) with the login-shell env.
import { realpath } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { GitActionResult } from '../../shared/types';
import type { NoteGitStatus } from '../../shared/notes';
import { isHiddenNoteName, isMarkdownName } from '../../core/notes/notePaths';
import { isStrictlyInside } from '../containment';
import { run, shortError } from '../git/gitService';
import { vaultRoot } from './vaultFs';

const COMMIT_MESSAGE_MAX = 5_000;

interface ChangedFile {
  /** Path relative to the repository top level (what git takes as pathspec from there). */
  top: string;
  /** Path relative to the vault. */
  vault: string;
}

export interface NoteGit {
  status(vault: string): Promise<NoteGitStatus>;
  commit(vault: string, message: string): Promise<GitActionResult<{ sha: string; files: number }>>;
}

export function createNoteGit(env: () => Record<string, string>): NoteGit {
  const git = (args: string[], cwd: string) => run('git', ['-c', 'core.quotepath=off', ...args], cwd, env());

  async function scan(vault: string): Promise<{ top: string; files: ChangedFile[] } | null> {
    const root = await vaultRoot(vault);
    const topRes = await git(['rev-parse', '--show-toplevel'], root);
    if (!topRes.ok) return null;
    const top = await realpath(topRes.stdout.trim());
    const res = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.'], root);
    if (!res.ok) return null;
    const parts = res.stdout.split('\0');
    const files: ChangedFile[] = [];
    const add = (topRel: string) => {
      const abs = join(top, topRel);
      if (abs !== root && !isStrictlyInside(root, abs)) return;
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
    return { top, files };
  }

  return {
    async status(vault) {
      const found = await scan(vault);
      return found ? { isRepo: true, changed: found.files.map((f) => f.vault) } : { isRepo: false, changed: [] };
    },

    async commit(vault, message) {
      const text = message.trim();
      if (!text) return { ok: false, error: '커밋 메시지를 입력하세요' };
      if (text.length > COMMIT_MESSAGE_MAX) return { ok: false, error: '커밋 메시지가 너무 깁니다' };
      const found = await scan(vault);
      if (!found) return { ok: false, error: '노트 폴더가 git 저장소가 아닙니다' };
      if (found.files.length === 0) return { ok: false, error: '커밋할 노트 변경 사항이 없습니다' };
      const paths = found.files.map((f) => f.top);
      const add = await git(['add', '-A', '--', ...paths], found.top);
      if (!add.ok) return { ok: false, error: `커밋하지 못했습니다: ${shortError(add.stderr)}` };
      // `--only` with paths: whatever else was staged in the repository stays out of this commit.
      const res = await git(['commit', '-q', '-m', text, '--only', '--', ...paths], found.top);
      if (!res.ok) return { ok: false, error: `커밋하지 못했습니다: ${shortError(res.stderr || res.stdout)}` };
      const sha = await git(['rev-parse', 'HEAD'], found.top);
      return { ok: true, sha: sha.stdout.trim(), files: paths.length };
    },
  };
}
