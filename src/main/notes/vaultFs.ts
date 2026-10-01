// 노트 모드 file operations, all inside one vault root. Every renderer path is normalized (notePaths.ts), joined to the
// vault's realpath and its realpath (or, for a new entry, its parent's realpath) must stay strictly inside the vault:
// `..`, absolute paths and symlinks that lead outside are refused. Only `.md` files are read or written (the real file
// too, not just the name the renderer used), never through a hard link; a write re-checks its folder right before it
// lands. Rename and trash act on the entry itself (a link is renamed / trashed, not what it points at), and a rename
// never replaces an existing entry.
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { link, lstat, mkdir, open, opendir, readFile, readdir, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';
import type { NoteDirListing, NoteEntry, NoteFile, NoteSearchResult } from '../../shared/notes';
import {
  NOTE_MAX_BYTES,
  baseName,
  isHiddenNoteName,
  isMarkdownName,
  noteNameError,
  normalizeNotePath,
  parentOf,
  withMarkdownExt,
} from '../../core/notes/notePaths';
import { isStrictlyInside } from '../containment';

/** Entries of one listed folder at most. */
export const LIST_DIR_MAX = 5_000;
/** Directory entries one listing reads at most (hidden / non-note entries included). */
export const LIST_DIR_VISIT_MAX = 50_000;
/** Entries a name search visits at most (vaults of several thousand notes stay well below). */
export const SEARCH_VISIT_MAX = 50_000;
export const SEARCH_RESULTS_MAX = 200;

export class NoteFsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoteFsError';
  }
}

function refuse(message: string): never {
  throw new NoteFsError(message);
}

/**
 * A folder too broad to register as a vault: `/`, a top-level folder (`/Users`, `/Volumes`, `/private`, …), a volume
 * root (`/Volumes/<disk>`), the home folder or anything above it.
 */
export async function isTooBroadVault(real: string): Promise<boolean> {
  const parts = real.split('/').filter(Boolean);
  if (parts.length <= 1) return true;
  if (parts[0] === 'Volumes' && parts.length === 2) return true;
  const home = await realpath(homedir()).catch(() => homedir());
  return real === home || isStrictlyInside(real, home);
}

/** Vault root as a realpath; refused when it is not a folder. */
export async function vaultRoot(path: string): Promise<string> {
  let real: string;
  try {
    real = await realpath(path);
  } catch {
    refuse('노트 폴더를 찾을 수 없습니다');
  }
  const st = await stat(real);
  if (!st.isDirectory()) refuse('노트 폴더가 폴더가 아닙니다');
  return real;
}

function inside(root: string, real: string): boolean {
  return real === root || isStrictlyInside(root, real);
}

function toRel(root: string, abs: string): string {
  return relative(root, abs).split(sep).join('/');
}

async function exists(abs: string): Promise<boolean> {
  try {
    await lstat(abs);
    return true;
  } catch {
    return false;
  }
}

/** Realpath of an existing entry inside the vault (`rel` already normalized). */
async function resolveExisting(root: string, rel: string): Promise<string> {
  let real: string;
  try {
    real = await realpath(join(root, rel));
  } catch {
    refuse('파일을 찾을 수 없습니다');
  }
  if (!inside(root, real)) refuse('노트 폴더 밖의 경로입니다');
  // A link inside the vault may still point at a hidden folder (`.git`): the real location is checked as well.
  if (real !== root && toRel(root, real).split('/').some(isHiddenNoteName)) refuse('숨김 폴더의 파일입니다');
  return real;
}

/** Target of a new entry: its parent must exist inside the vault; the entry itself must not exist yet. */
async function resolveNew(root: string, rel: string): Promise<string> {
  const parent = parentOf(rel);
  const realParent = parent === '' ? root : await resolveExisting(root, parent);
  const target = join(realParent, baseName(rel));
  if (await exists(target)) refuse('같은 이름이 이미 있습니다');
  return target;
}

function needPath(raw: unknown, opts: { allowRoot?: boolean } = {}): string {
  const rel = normalizeNotePath(raw, opts);
  if (rel === null) refuse('올바르지 않은 경로입니다');
  return rel;
}

function needMarkdown(rel: string): void {
  if (!isMarkdownName(baseName(rel))) refuse('.md 파일만 열고 저장할 수 있습니다');
}

/** The resolved file itself is a `.md` file (a `note.md` link to `secret.txt` is refused). */
function needMarkdownReal(real: string): void {
  if (!isMarkdownName(basename(real))) refuse('.md 파일만 열고 저장할 수 있습니다');
}

/**
 * The entry itself (a link is not followed): its folder resolved and contained, the last segment kept as is. The
 * entry must also resolve inside the vault (resolveExisting) like every other operation.
 */
async function resolveEntry(root: string, rel: string): Promise<{ entry: string; real: string; isLink: boolean; isDir: boolean }> {
  const real = await resolveExisting(root, rel);
  const parent = parentOf(rel);
  const realParent = parent === '' ? root : await resolveExisting(root, parent);
  const entry = join(realParent, baseName(rel));
  const st = await lstat(entry);
  return { entry, real, isLink: st.isSymbolicLink(), isDir: st.isDirectory() };
}

const collator = new Intl.Collator('ko', { numeric: true, sensitivity: 'base' });

export async function listDir(vault: string, dir: unknown): Promise<NoteDirListing> {
  const root = await vaultRoot(vault);
  const rel = needPath(dir, { allowRoot: true });
  const abs = rel === '' ? root : await resolveExisting(root, rel);
  // Streamed: a huge folder is read only up to the caps, never into one array.
  const handle = await opendir(abs, { bufferSize: 256 });
  const entries: NoteEntry[] = [];
  let truncated = false;
  let visited = 0;
  for await (const d of handle) {
    if (++visited > LIST_DIR_VISIT_MAX) {
      truncated = true;
      break;
    }
    if (isHiddenNoteName(d.name)) continue;
    let kind: 'dir' | 'file' | null = d.isDirectory() ? 'dir' : d.isFile() ? 'file' : null;
    if (d.isSymbolicLink()) {
      // Links are listed only when they resolve inside the vault.
      try {
        const real = await realpath(join(abs, d.name));
        if (!inside(root, real)) continue;
        const st = await stat(real);
        kind = st.isDirectory() ? 'dir' : st.isFile() ? 'file' : null;
      } catch {
        continue;
      }
    }
    if (kind === null || (kind === 'file' && !isMarkdownName(d.name))) continue;
    if (entries.length >= LIST_DIR_MAX) {
      truncated = true;
      break;
    }
    entries.push({ name: d.name, path: rel === '' ? d.name : `${rel}/${d.name}`, kind });
  }
  entries.sort((a, b) => (a.kind === b.kind ? collator.compare(a.name, b.name) : a.kind === 'dir' ? -1 : 1));
  return { entries, truncated };
}

/** Breadth-first walk of the vault for `.md` names containing `query` (links are not followed). */
export async function searchNames(vault: string, query: unknown): Promise<NoteSearchResult> {
  if (typeof query !== 'string') refuse('검색어가 필요합니다');
  const q = query.trim().toLowerCase();
  if (!q) return { paths: [], truncated: false };
  const root = await vaultRoot(vault);
  const paths: string[] = [];
  const queue: string[] = [''];
  let visited = 0;
  while (queue.length > 0) {
    const rel = queue.shift() as string;
    let dirents;
    try {
      dirents = await readdir(rel === '' ? root : join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    dirents.sort((a, b) => collator.compare(a.name, b.name));
    for (const d of dirents) {
      if (++visited > SEARCH_VISIT_MAX) return { paths, truncated: true };
      if (isHiddenNoteName(d.name)) continue;
      const child = rel === '' ? d.name : `${rel}/${d.name}`;
      if (d.isDirectory()) queue.push(child);
      else if (d.isFile() && isMarkdownName(d.name) && d.name.toLowerCase().includes(q)) {
        paths.push(child);
        if (paths.length >= SEARCH_RESULTS_MAX) return { paths, truncated: true };
      }
    }
  }
  return { paths, truncated: false };
}

export async function readNote(vault: string, path: unknown): Promise<NoteFile> {
  const root = await vaultRoot(vault);
  const rel = needPath(path);
  needMarkdown(rel);
  const abs = await resolveExisting(root, rel);
  needMarkdownReal(abs);
  const st = await stat(abs);
  if (!st.isFile()) refuse('파일이 아닙니다');
  if (st.size > NOTE_MAX_BYTES) refuse('2 MB보다 큰 노트는 열 수 없습니다');
  return { text: await readFile(abs, 'utf8'), mtimeMs: st.mtimeMs };
}

/** Temp file in the same folder, then rename over the target (never a half-written note). */
export async function atomicWrite(target: string, text: string): Promise<void> {
  const tmp = join(dirname(target), `.${basename(target)}.${randomBytes(6).toString('hex')}.tmp`);
  let mode: number | undefined;
  try {
    mode = (await stat(target)).mode & 0o777;
  } catch {
    mode = undefined;
  }
  try {
    await writeFile(tmp, text, { encoding: 'utf8', flag: 'wx', ...(mode !== undefined ? { mode } : {}) });
    await rename(tmp, target);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

export async function writeNote(vault: string, path: unknown, text: unknown): Promise<{ mtimeMs: number }> {
  if (typeof text !== 'string') refuse('내용이 필요합니다');
  if (Buffer.byteLength(text, 'utf8') > NOTE_MAX_BYTES) refuse('노트는 2 MB까지 저장할 수 있습니다');
  const root = await vaultRoot(vault);
  const rel = needPath(path);
  needMarkdown(rel);
  const target = (await exists(join(root, rel))) ? await resolveExisting(root, rel) : await resolveNew(root, rel);
  needMarkdownReal(target);
  if (await exists(target)) {
    const st = await lstat(target);
    if (!st.isFile()) refuse('파일이 아닙니다');
    if (st.nlink > 1) refuse('하드 링크된 파일에는 저장할 수 없습니다');
  }
  // The folder may have been swapped for a link since it was resolved: checked again right before the write.
  const folder = dirname(target);
  const realFolder = await realpath(folder).catch(() => null);
  if (realFolder !== folder || !inside(root, realFolder)) refuse('노트 폴더 밖의 경로입니다');
  await atomicWrite(target, text);
  return { mtimeMs: (await stat(target)).mtimeMs };
}

export async function createEntry(vault: string, path: unknown, kind: unknown): Promise<NoteEntry> {
  if (kind !== 'file' && kind !== 'dir') refuse('종류가 올바르지 않습니다');
  const root = await vaultRoot(vault);
  const raw = needPath(path);
  const nameError = noteNameError(baseName(raw));
  if (nameError) refuse(nameError);
  const rel = kind === 'file' ? `${parentOf(raw) ? `${parentOf(raw)}/` : ''}${withMarkdownExt(baseName(raw))}` : raw;
  const target = await resolveNew(root, rel);
  if (kind === 'dir') await mkdir(target);
  else {
    const fh = await open(target, 'wx');
    await fh.close();
  }
  return { name: baseName(rel), path: rel, kind };
}

export async function renameEntry(vault: string, path: unknown, name: unknown): Promise<NoteEntry> {
  if (typeof name !== 'string') refuse('이름이 필요합니다');
  const root = await vaultRoot(vault);
  const rel = needPath(path);
  const { entry: source, real, isLink, isDir: isDirEntry } = await resolveEntry(root, rel);
  if (real === root) refuse('노트 폴더 자체는 바꿀 수 없습니다');
  // A link keeps the kind of what it points at (the tree shows it that way).
  const isDir = isDirEntry || (isLink && (await stat(real)).isDirectory());
  if (!isDir) needMarkdown(rel);
  const nameError = noteNameError(name);
  if (nameError) refuse(nameError);
  const finalName = isDir ? name : withMarkdownExt(name);
  const parent = parentOf(rel);
  const nextRel = parent ? `${parent}/${finalName}` : finalName;
  if (nextRel === rel) return { name: finalName, path: rel, kind: isDir ? 'dir' : 'file' };
  const target = join(dirname(source), finalName);
  const kind = isDir ? 'dir' : 'file';
  const existing = await lstat(target).catch(() => null);
  if (existing) {
    // Case-only renames on a case-insensitive volume find the source itself under the new name.
    const src = await lstat(source);
    if (existing.ino !== src.ino || existing.dev !== src.dev) refuse('같은 이름이 이미 있습니다');
    await rename(source, target);
    return { name: finalName, path: nextRel, kind };
  }
  if (!isDirEntry && !isLink) {
    // A file: link + unlink never replaces an entry that appeared in the meantime (link fails with EEXIST).
    try {
      await link(source, target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') refuse('같은 이름이 이미 있습니다');
      throw err;
    }
    await unlink(source);
  } else {
    // A folder or a link: rename(2) has no no-replace flag here; the name was checked just above.
    await rename(source, target);
  }
  return { name: finalName, path: nextRel, kind };
}

export async function trashEntry(vault: string, path: unknown, trash: (abs: string) => Promise<void>): Promise<void> {
  const root = await vaultRoot(vault);
  const rel = needPath(path);
  const { entry, real, isLink, isDir: isDirEntry } = await resolveEntry(root, rel);
  if (real === root || entry === root) refuse('노트 폴더 자체는 지울 수 없습니다');
  const isDir = isDirEntry || (isLink && (await stat(real)).isDirectory());
  if (!isDir) needMarkdown(rel);
  // The entry itself: a link goes to the Trash, not what it points at.
  await trash(entry);
}

/**
 * Up to `max` other `.md` files of the note's folder (style references for AI requests), read through the same
 * containment checks. Missing / unreadable files are skipped.
 */
export async function siblingNotes(vault: string, path: string, max: number): Promise<{ path: string; text: string }[]> {
  const parent = parentOf(path);
  let listing: NoteDirListing;
  try {
    listing = await listDir(vault, parent);
  } catch {
    return [];
  }
  const out: { path: string; text: string }[] = [];
  for (const e of listing.entries) {
    if (out.length >= max) break;
    if (e.kind !== 'file' || e.path === path) continue;
    try {
      const file = await readNote(vault, e.path);
      if (file.text.trim()) out.push({ path: e.path, text: file.text });
    } catch {
      // skipped
    }
  }
  return out;
}
