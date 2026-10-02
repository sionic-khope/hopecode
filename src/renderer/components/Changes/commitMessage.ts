import type { GitChangedFile, GitFileStatus } from '../../../shared/types';
import { t, type MessageKey } from '../../../shared/i18n';

/** Longest subject line git tooling displays without wrapping. */
export const SUBJECT_MAX = 72;
/** Files listed in the body before the rest collapse into "…외 N개". */
export const BODY_MAX_FILES = 10;

const VERB_KEY: Record<GitFileStatus, MessageKey> = {
  A: 'commit.verb.add',
  M: 'commit.verb.modify',
  D: 'commit.verb.delete',
  R: 'commit.verb.rename',
  U: 'commit.verb.resolve',
};
const verbOf = (status: GitFileStatus): string => t(VERB_KEY[status]);
/** The change kind as a count label in a mixed subject (`추가 2` / `added 2`). */
const KIND_KEY: Record<GitFileStatus, MessageKey> = {
  A: 'commit.kind.add',
  M: 'commit.kind.modify',
  D: 'commit.kind.delete',
  R: 'commit.kind.rename',
  U: 'commit.kind.resolve',
};
/** `<target> 수정` / `Update <target>`: word order follows the language. */
const single = (target: string, verb: string): string => t('commit.subject.single', { target, verb });

/** Order of the per-kind counts in a mixed subject. */
const COUNT_ORDER: readonly GitFileStatus[] = ['A', 'M', 'D', 'R', 'U'];

export interface ChangeCounts {
  files: number;
  additions: number;
  deletions: number;
}

export function summarizeCounts(files: readonly GitChangedFile[]): ChangeCounts {
  let additions = 0;
  let deletions = 0;
  for (const f of files) {
    additions += f.additions;
    deletions += f.deletions;
  }
  return { files: files.length, additions, deletions };
}

function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(i + 1) : path;
}

function topDir(path: string): string | null {
  const i = path.indexOf('/');
  return i > 0 ? path.slice(0, i) : null;
}

function clamp(text: string, max = SUBJECT_MAX): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Tries the full path first, then basenames, then truncates. */
function singleSubject(file: GitChangedFile): string {
  const verb = verbOf(file.status);
  if (file.status === 'R' && file.oldPath) {
    const full = single(`${file.oldPath} → ${file.path}`, verb);
    if (full.length <= SUBJECT_MAX) return full;
    return clamp(single(`${basename(file.oldPath)} → ${basename(file.path)}`, verb));
  }
  const full = single(file.path, verb);
  if (full.length <= SUBJECT_MAX) return full;
  return clamp(single(basename(file.path), verb));
}

function subjectLine(files: readonly GitChangedFile[]): string {
  if (files.length === 1) return singleSubject(files[0]!);

  const dirs = new Set(files.map((f) => topDir(f.path)));
  const [onlyDir] = dirs;
  const scope = dirs.size === 1 && onlyDir ? `${onlyDir}/ ` : '';

  const byStatus = new Map<GitFileStatus, number>();
  for (const f of files) byStatus.set(f.status, (byStatus.get(f.status) ?? 0) + 1);

  if (byStatus.size === 1) {
    const [status] = byStatus.keys();
    return clamp(t('commit.subject.same', { scope, count: files.length, verb: verbOf(status!) }));
  }
  const parts = COUNT_ORDER.filter((s) => byStatus.has(s)).map((s) => `${t(KIND_KEY[s])} ${byStatus.get(s)}`);
  return clamp(t('commit.subject.mixed', { scope, count: files.length, parts: parts.join(', ') }));
}

function bodyLine(file: GitChangedFile): string {
  const name = file.status === 'R' && file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;
  const stat = file.binary ? t('commit.binary') : `(+${file.additions} −${file.deletions})`;
  return `- ${file.status} ${name} ${stat}`;
}

/**
 * Rule-based commit message: a subject (≤ 72 chars) summarizing the change, a blank line, and a bullet list of
 * up to 10 files with their line counts. Empty input yields ''.
 */
export function autoCommitMessage(files: readonly GitChangedFile[]): string {
  if (files.length === 0) return '';
  const lines = files.slice(0, BODY_MAX_FILES).map(bodyLine);
  if (files.length > BODY_MAX_FILES) lines.push(`- ${t('commit.more', { count: files.length - BODY_MAX_FILES })}`);
  return `${subjectLine(files)}\n\n${lines.join('\n')}`;
}
