// Git operations behind the changes panel / commit / merge / PR flow (contracts.ts GitService).
// Every git / gh run is execFile (never a shell string) with the injected child env; every repo-relative
// path argument is containment-checked against the thread cwd before it reaches git or the filesystem.
import { execFile } from 'node:child_process';
import { lstat, open, realpath, rm } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { isStrictlyInside } from '../containment';
import type { GitService } from '../contracts';
import type { GitChangedFile, GitChanges, GitFileDiff, GitFileStatus, GitRemoteInfo, StructuredPatchHunk } from '../../shared/types';
import { branchNameError } from '../../core/branchName';
import { parseUnifiedDiff } from './unifiedDiff';

export interface GitServiceDeps {
  /** Child env for git / gh (shellEnv.childEnv({})). */
  env?: () => Record<string, string>;
  /** Publishing seam: real = runs `git push` / `gh pr create`; fixture/e2e passes a fake that never touches the network. */
  publisher?: GitPublisher;
}

export interface GitPublisher {
  /** true when the `gh` CLI can be run. */
  ghAvailable(): Promise<boolean>;
  push(cwd: string, remote: string, branch: string): Promise<void>;
  /** Returns the PR URL gh printed (or null). */
  createPr(cwd: string, opts: { title: string; body: string; base: string; head: string }): Promise<string | null>;
}

interface RunResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
}

const MAX_BUFFER = 256 * 1024 * 1024;
/** Untracked files are read at most this far for line counts / synthesized diffs. */
const READ_CAP = 2 * 1024 * 1024;

function run(cmd: string, args: string[], cwd: string, env: Record<string, string> | undefined, timeout?: number): Promise<RunResult> {
  return new Promise((done) => {
    execFile(
      cmd,
      args,
      { cwd, maxBuffer: MAX_BUFFER, ...(env ? { env } : {}), ...(timeout ? { timeout } : {}) },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : -1) : 0;
        done({ ok: !err, code, stdout: stdout.toString(), stderr: stderr.toString() || (err ? err.message : '') });
      },
    );
  });
}

/** Last few stderr lines joined (git puts the actual reason last). */
function shortError(text: string): string {
  return text.trim().split('\n').slice(-3).join(' ').trim();
}

/** Real publisher: `git push -u` and `gh pr create` on the login-shell PATH. */
export function createGitPublisher(env?: () => Record<string, string>): GitPublisher {
  return {
    async ghAvailable() {
      const res = await run('gh', ['--version'], process.cwd(), env?.(), 5000);
      return res.ok;
    },
    async push(cwd, remote, branch) {
      const res = await run('git', ['push', '-u', remote, branch], cwd, env?.());
      if (!res.ok) throw new Error(shortError(res.stderr) || 'git push failed');
    },
    async createPr(cwd, opts) {
      const res = await run(
        'gh',
        ['pr', 'create', '--title', opts.title, '--body', opts.body, '--base', opts.base, '--head', opts.head],
        cwd,
        env?.(),
      );
      if (!res.ok) throw new Error(shortError(res.stderr) || 'gh pr create failed');
      const urls = res.stdout.match(/https?:\/\/\S+/g);
      return urls ? urls[urls.length - 1] : null;
    },
  };
}

/** Throws unless `path` is a relative path that resolves strictly inside `cwd`. */
function checkPath(cwd: string, path: string): void {
  if (!path || isAbsolute(path) || path.split(/[\\/]/).includes('..') || !isStrictlyInside(cwd, resolve(cwd, path))) {
    throw new Error(`path outside the thread folder: ${path}`);
  }
}

function splitZ(out: string): string[] {
  const parts = out.split('\0');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts;
}

async function readCapped(path: string): Promise<{ text: string; binary: boolean } | null> {
  try {
    const info = await lstat(path);
    if (!info.isFile()) return { text: '', binary: false };
    const handle = await open(path, 'r');
    try {
      const buf = Buffer.alloc(Math.min(info.size, READ_CAP));
      const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
      const data = buf.subarray(0, bytesRead);
      if (data.subarray(0, 8000).includes(0)) return { text: '', binary: true };
      return { text: data.toString('utf8'), binary: false };
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) n += 1;
  return text.endsWith('\n') ? n : n + 1;
}

/** One all-'+' hunk for a file git has no base version of. */
function addedHunk(text: string): StructuredPatchHunk[] {
  if (text.length === 0) return [];
  const lines = text.split('\n');
  const trailingNewline = text.endsWith('\n');
  if (trailingNewline) lines.pop();
  const out = lines.map((l) => `+${l}`);
  if (!trailingNewline) out.push('\\ No newline at end of file');
  return [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines: out }];
}

function mapStatus(letter: string): GitFileStatus {
  switch (letter[0]) {
    case 'A':
      return 'A';
    case 'D':
      return 'D';
    case 'R':
      return 'R';
    case 'U':
      return 'U';
    default:
      return 'M';
  }
}

interface RepoState {
  isRepo: boolean;
  branch: string | null;
  /** cwd is a linked worktree of projectPath. */
  worktree: boolean;
  baseBranch: string | null;
  /** Commit to diff against; null in a repo without commits. */
  base: string | null;
}

const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '--relative', '-M'];

export function createGitService(deps: GitServiceDeps = {}): GitService {
  const publisher = deps.publisher ?? createGitPublisher(deps.env);
  // quotepath=off keeps non-ASCII names readable; parsed outputs additionally use -z.
  const git = (args: string[], cwd: string): Promise<RunResult> => run('git', ['-c', 'core.quotepath=off', ...args], cwd, deps.env?.());

  async function currentBranch(dir: string): Promise<string | null> {
    // symbolic-ref also works on an unborn branch; it fails (-> null) when HEAD is detached.
    const res = await git(['symbolic-ref', '--short', '-q', 'HEAD'], dir);
    return res.ok ? res.stdout.trim() || null : null;
  }

  async function commonDir(dir: string): Promise<string | null> {
    const res = await git(['rev-parse', '--git-common-dir'], dir);
    if (!res.ok) return null;
    try {
      return await realpath(resolve(dir, res.stdout.trim()));
    } catch {
      return null;
    }
  }

  async function sameDir(a: string, b: string): Promise<boolean> {
    try {
      return (await realpath(a)) === (await realpath(b));
    } catch {
      return resolve(a) === resolve(b);
    }
  }

  async function repoState(cwd: string, projectPath: string): Promise<RepoState> {
    const inside = await git(['rev-parse', '--is-inside-work-tree'], cwd);
    if (!inside.ok || inside.stdout.trim() !== 'true') {
      return { isRepo: false, branch: null, worktree: false, baseBranch: null, base: null };
    }
    const branch = await currentBranch(cwd);
    const headRes = await git(['rev-parse', '--verify', '-q', 'HEAD'], cwd);
    const head = headRes.ok ? headRes.stdout.trim() : null;

    let worktree = false;
    if (!(await sameDir(cwd, projectPath))) {
      const [mine, theirs] = await Promise.all([commonDir(cwd), commonDir(projectPath)]);
      worktree = mine !== null && mine === theirs;
    }
    if (!worktree || !head) return { isRepo: true, branch, worktree, baseBranch: null, base: head };

    const baseBranch = await currentBranch(projectPath);
    let base = head;
    if (baseBranch) {
      const mb = await git(['merge-base', 'HEAD', `refs/heads/${baseBranch}`], cwd);
      if (mb.ok && mb.stdout.trim()) base = mb.stdout.trim();
    }
    return { isRepo: true, branch, worktree, baseBranch, base };
  }

  async function isDirty(dir: string, ignoreUntracked = false): Promise<boolean> {
    const res = await git(['status', '--porcelain'], dir);
    if (!res.ok) return false;
    return res.stdout.split('\n').some((l) => l.trim().length > 0 && !(ignoreUntracked && l.startsWith('??')));
  }

  async function untrackedPaths(cwd: string, pathspec: string[] = []): Promise<string[]> {
    const res = await git(['ls-files', '--others', '--exclude-standard', '-z', '--', ...pathspec], cwd);
    return res.ok ? splitZ(res.stdout) : [];
  }

  async function addedFile(cwd: string, path: string, untracked: boolean): Promise<GitChangedFile> {
    const content = await readCapped(resolve(cwd, path));
    const binary = content?.binary ?? false;
    return { path, status: 'A', untracked, additions: content && !binary ? countLines(content.text) : 0, deletions: 0, binary };
  }

  /** name-status entries vs `base`: path -> { status, oldPath }. */
  async function nameStatus(cwd: string, base: string): Promise<{ path: string; oldPath?: string; status: GitFileStatus }[]> {
    const res = await git(['diff', ...DIFF_FLAGS, '--name-status', '-z', base], cwd);
    if (!res.ok) return [];
    const parts = splitZ(res.stdout);
    const out: { path: string; oldPath?: string; status: GitFileStatus }[] = [];
    for (let i = 0; i < parts.length; ) {
      const letter = parts[i];
      if (letter.startsWith('R')) {
        out.push({ path: parts[i + 2], oldPath: parts[i + 1], status: 'R' });
        i += 3;
      } else if (letter.startsWith('C')) {
        out.push({ path: parts[i + 2], status: 'A' });
        i += 3;
      } else {
        out.push({ path: parts[i + 1], status: mapStatus(letter) });
        i += 2;
      }
    }
    return out;
  }

  async function numStat(cwd: string, base: string): Promise<Map<string, { additions: number; deletions: number; binary: boolean }>> {
    const res = await git(['diff', ...DIFF_FLAGS, '--numstat', '-z', base], cwd);
    const stats = new Map<string, { additions: number; deletions: number; binary: boolean }>();
    if (!res.ok) return stats;
    const parts = splitZ(res.stdout);
    for (let i = 0; i < parts.length; ) {
      const [added, deleted, ...rest] = parts[i].split('\t');
      let path = rest.join('\t');
      i += 1;
      if (path === '') {
        // Rename: "<a>\t<d>\t\0<old>\0<new>\0".
        path = parts[i + 1];
        i += 2;
      }
      const binary = added === '-' && deleted === '-';
      stats.set(path, { additions: binary ? 0 : Number(added), deletions: binary ? 0 : Number(deleted), binary });
    }
    return stats;
  }

  async function revertResult(cwd: string, path: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const fail = (why: string) => ({ ok: false as const, error: `되돌리지 못했습니다: ${why}` });
    const target = resolve(cwd, path);
    const inHead = (await git(['cat-file', '-e', `HEAD:./${path}`], cwd)).ok;
    if (inHead) {
      const res = await git(['checkout', 'HEAD', '--', path], cwd);
      return res.ok ? { ok: true } : fail(shortError(res.stderr));
    }
    const inIndex = (await git(['ls-files', '--error-unmatch', '--', path], cwd)).ok;
    if (inIndex) {
      // A staged rename: bring the original name back as well.
      const head = await git(['rev-parse', '--verify', '-q', 'HEAD'], cwd);
      const renamedFrom = head.ok ? (await nameStatus(cwd, 'HEAD')).find((f) => f.path === path && f.status === 'R')?.oldPath : undefined;
      const res = await git(['rm', '--cached', '-f', '-q', '--', path], cwd);
      if (!res.ok) return fail(shortError(res.stderr));
      if (renamedFrom) {
        const restore = await git(['checkout', 'HEAD', '--', renamedFrom], cwd);
        if (!restore.ok) return fail(shortError(restore.stderr));
      }
    }
    // Only ever delete a file git reports as untracked (never an ignored one such as .env).
    if (!inIndex && !(await untrackedPaths(cwd, [path])).includes(path)) return fail('변경된 파일이 아닙니다');
    try {
      const info = await lstat(target);
      if (info.isDirectory()) return fail('폴더는 되돌릴 수 없습니다');
      await rm(target, { force: true });
    } catch (err) {
      if (!inIndex) return fail(err instanceof Error && 'code' in err && err.code === 'ENOENT' ? '파일을 찾을 수 없습니다' : String(err));
    }
    return { ok: true };
  }

  async function remoteInfo(cwd: string, projectPath: string): Promise<GitRemoteInfo> {
    const ghAvailable = await publisher.ghAvailable().catch(() => false);
    const state = await repoState(cwd, projectPath);
    if (!state.isRepo) return { remote: null, remoteUrl: null, branch: null, baseBranch: null, ghAvailable };
    const remotes = (await git(['remote'], cwd)).stdout.split('\n').map((r) => r.trim()).filter(Boolean);
    const remote = remotes.includes('origin') ? 'origin' : (remotes[0] ?? null);
    let remoteUrl: string | null = null;
    let baseBranch = state.baseBranch;
    if (remote) {
      const url = await git(['remote', 'get-url', remote], cwd);
      remoteUrl = url.ok ? url.stdout.trim() || null : null;
      if (!state.worktree) {
        const head = await git(['symbolic-ref', '--short', '-q', `refs/remotes/${remote}/HEAD`], cwd);
        const ref = head.ok ? head.stdout.trim() : '';
        baseBranch = ref.startsWith(`${remote}/`) ? ref.slice(remote.length + 1) : null;
      }
    }
    return { remote, remoteUrl, branch: state.branch, baseBranch, ghAvailable };
  }

  return {
    async changes(cwd, projectPath): Promise<GitChanges> {
      const state = await repoState(cwd, projectPath);
      if (!state.isRepo) return { isRepo: false, branch: null, baseBranch: null, files: [], ahead: 0, dirty: false };

      const files: GitChangedFile[] = [];
      if (state.base === null) {
        // No commits yet: everything present is an addition.
        const cached = await git(['ls-files', '--cached', '-z'], cwd);
        for (const path of cached.ok ? splitZ(cached.stdout) : []) files.push(await addedFile(cwd, path, false));
      } else {
        const [entries, stats] = await Promise.all([nameStatus(cwd, state.base), numStat(cwd, state.base)]);
        for (const entry of entries) {
          const stat = stats.get(entry.path) ?? { additions: 0, deletions: 0, binary: false };
          const file: GitChangedFile = { path: entry.path, status: entry.status, untracked: false, ...stat };
          if (entry.oldPath !== undefined) file.oldPath = entry.oldPath;
          files.push(file);
        }
      }
      const known = new Set(files.map((f) => f.path));
      for (const path of await untrackedPaths(cwd)) {
        if (!known.has(path)) files.push(await addedFile(cwd, path, true));
      }
      files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

      let ahead = 0;
      if (state.worktree && state.baseBranch) {
        const count = await git(['rev-list', '--count', `refs/heads/${state.baseBranch}..HEAD`], cwd);
        ahead = count.ok ? Number(count.stdout.trim()) || 0 : 0;
      }
      return { isRepo: true, branch: state.branch, baseBranch: state.baseBranch, files, ahead, dirty: await isDirty(cwd) };
    },

    async fileDiff(cwd, projectPath, path): Promise<GitFileDiff> {
      checkPath(cwd, path);
      const empty: GitFileDiff = { path, binary: false, hunks: [] };
      const state = await repoState(cwd, projectPath);
      if (!state.isRepo) return empty;

      const untracked = (await untrackedPaths(cwd, [path])).includes(path);
      const tracked = !untracked && (await git(['ls-files', '--error-unmatch', '--', path], cwd)).ok;
      if (untracked || (state.base === null && tracked)) {
        const content = await readCapped(resolve(cwd, path));
        if (!content) return empty;
        return { path, binary: content.binary, hunks: content.binary ? [] : addedHunk(content.text) };
      }
      if (state.base === null) return empty;

      // Include a rename's old name in the pathspec so git pairs the two sides.
      const oldPath = (await nameStatus(cwd, state.base)).find((f) => f.path === path)?.oldPath;
      const pathspec = oldPath ? [oldPath, path] : [path];
      const res = await git(['diff', ...DIFF_FLAGS, '--src-prefix=a/', '--dst-prefix=b/', state.base, '--', ...pathspec], cwd);
      if (!res.ok) return empty;
      const parsed = parseUnifiedDiff(res.stdout).find((f) => f.path === path);
      return parsed ? { path, binary: parsed.binary, hunks: parsed.hunks } : empty;
    },

    async revertFile(cwd, path) {
      checkPath(cwd, path);
      return revertResult(cwd, path);
    },

    async commit(cwd, message) {
      const text = message.trim();
      if (!text) return { ok: false, error: '커밋 메시지를 입력하세요' };
      const add = await git(['add', '-A'], cwd);
      if (!add.ok) return { ok: false, error: `커밋하지 못했습니다: ${shortError(add.stderr)}` };
      const staged = await git(['diff', '--cached', '--quiet'], cwd);
      if (staged.ok) return { ok: false, error: '커밋할 변경 사항이 없습니다' };
      const res = await git(['commit', '-q', '-m', text], cwd);
      if (!res.ok) return { ok: false, error: `커밋하지 못했습니다: ${shortError(res.stderr || res.stdout)}` };
      const sha = await git(['rev-parse', 'HEAD'], cwd);
      return { ok: true, sha: sha.stdout.trim() };
    },

    async merge(cwd, projectPath) {
      const state = await repoState(cwd, projectPath);
      if (!state.isRepo || !state.worktree) return { ok: false, error: 'worktree 스레드가 아닙니다' };
      if (!state.branch) return { ok: false, error: '브랜치가 없는 상태(detached HEAD)에서는 병합할 수 없습니다' };
      if (await isDirty(cwd)) return { ok: false, error: '먼저 변경 사항을 커밋하세요' };
      // Untracked files in the project folder are left to git: it refuses by itself if the merge would overwrite one.
      if (await isDirty(projectPath, true)) return { ok: false, error: '원래 브랜치 폴더에 커밋하지 않은 변경 사항이 있습니다' };
      if (!state.baseBranch) return { ok: false, error: '원래 브랜치 폴더가 브랜치에 있지 않습니다(detached HEAD)' };

      const res = await git(['merge', '--no-ff', '--no-edit', state.branch], projectPath);
      if (res.ok) return { ok: true, into: state.baseBranch };
      const conflicted = await git(['diff', '--name-only', '--diff-filter=U', '-z'], projectPath);
      const names = conflicted.ok ? splitZ(conflicted.stdout) : [];
      await git(['merge', '--abort'], projectPath);
      if (names.length > 0) return { ok: false, error: `병합 충돌이 발생해 병합을 취소했습니다: ${names.join(', ')}` };
      return { ok: false, error: `병합하지 못했습니다: ${shortError(res.stderr || res.stdout)}` };
    },

    remoteInfo,

    async pushAndOpenPr(cwd, projectPath, title, body) {
      const prTitle = title.trim();
      if (!prTitle) return { ok: false, error: 'PR 제목을 입력하세요' };
      const info = await remoteInfo(cwd, projectPath);
      if (!info.remote) return { ok: false, error: '원격 저장소(remote)가 없습니다' };
      if (!info.branch) return { ok: false, error: '현재 브랜치를 확인할 수 없습니다' };
      if (!info.baseBranch) return { ok: false, error: 'PR 대상 브랜치를 확인할 수 없습니다' };
      if (info.branch === info.baseBranch) return { ok: false, error: 'PR 대상 브랜치와 같은 브랜치입니다' };
      if (!info.ghAvailable) return { ok: false, error: 'gh CLI를 찾을 수 없습니다' };
      if (await isDirty(cwd)) return { ok: false, error: '먼저 변경 사항을 커밋하세요' };
      try {
        await publisher.push(cwd, info.remote, info.branch);
      } catch (err) {
        return { ok: false, error: `푸시하지 못했습니다: ${err instanceof Error ? err.message : String(err)}` };
      }
      try {
        const url = await publisher.createPr(cwd, { title: prTitle, body, base: info.baseBranch, head: info.branch });
        return { ok: true, url };
      } catch (err) {
        return { ok: false, error: `PR을 만들지 못했습니다: ${err instanceof Error ? err.message : String(err)}` };
      }
    },

    async createBranch(cwd, name) {
      const invalid = branchNameError(name);
      if (invalid) return { ok: false, error: invalid };
      const inside = await git(['rev-parse', '--is-inside-work-tree'], cwd);
      if (!inside.ok || inside.stdout.trim() !== 'true') return { ok: false, error: 'git 저장소가 아닙니다' };
      const format = await git(['check-ref-format', '--branch', name], cwd);
      if (!format.ok) return { ok: false, error: '브랜치 이름으로 쓸 수 없습니다' };
      const exists = await git(['rev-parse', '--verify', '-q', `refs/heads/${name}`], cwd);
      if (exists.ok) return { ok: false, error: `이미 있는 브랜치입니다: ${name}` };
      // A leading '-' is refused above, so git never reads the name as an option.
      const res = await git(['switch', '-c', name], cwd);
      if (!res.ok) return { ok: false, error: `브랜치를 만들지 못했습니다: ${shortError(res.stderr || res.stdout)}` };
      return { ok: true, branch: name };
    },
  };
}
