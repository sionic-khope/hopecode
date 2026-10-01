// Vault-relative note paths as the renderer sends them (posix `/`). Pure checks; main still resolves every path and
// compares realpaths against the vault root before touching the disk.

/** Folders never listed, searched, read or written (besides every name starting with `.`). */
export const IGNORED_NOTE_DIRS: ReadonlySet<string> = new Set(['node_modules', 'public', '__pycache__']);

export const NOTE_PATH_MAX = 1024;
export const NOTE_NAME_MAX = 200;
/** Largest note read or written. */
export const NOTE_MAX_BYTES = 2 * 1024 * 1024;

/** A name the tree hides: dot-names (`.git`, `.obsidian`) and IGNORED_NOTE_DIRS. */
export function isHiddenNoteName(name: string): boolean {
  return name.startsWith('.') || IGNORED_NOTE_DIRS.has(name);
}

export function isMarkdownName(name: string): boolean {
  return /\.md$/i.test(name) && name.length > 3;
}

/** One path segment a user may type for a new or renamed entry; null when it is not acceptable. */
export function noteNameError(name: string): string | null {
  if (name.length === 0 || name.trim() !== name) return '이름 앞뒤에 공백을 둘 수 없습니다';
  if (name.length > NOTE_NAME_MAX) return `이름은 ${NOTE_NAME_MAX}자까지 쓸 수 있습니다`;
  if (name === '.' || name === '..' || name.includes('/') || name.includes('\\')) return '이름에 / 나 .. 를 쓸 수 없습니다';
  if (/[\u0000-\u001f\u007f:]/.test(name)) return '이름에 제어 문자나 : 를 쓸 수 없습니다';
  if (isHiddenNoteName(name)) return '. 으로 시작하거나 숨김 폴더와 같은 이름은 쓸 수 없습니다';
  return null;
}

/**
 * Normalized vault-relative path, or null when it is not one: absolute paths, `.` / `..` / empty segments, control
 * characters and hidden segments are refused. `''` (the vault root) only when `allowRoot`.
 */
export function normalizeNotePath(raw: unknown, opts: { allowRoot?: boolean } = {}): string | null {
  if (typeof raw !== 'string' || raw.length > NOTE_PATH_MAX) return null;
  if (raw === '') return opts.allowRoot ? '' : null;
  if (raw.startsWith('/') || raw.includes('\\') || /[\u0000-\u001f\u007f]/.test(raw)) return null;
  const segments = raw.split('/');
  for (const s of segments) {
    if (s === '' || s === '.' || s === '..' || isHiddenNoteName(s)) return null;
  }
  return segments.join('/');
}

/** `name` with `.md` appended unless it already ends with it. */
export function withMarkdownExt(name: string): string {
  return isMarkdownName(name) ? name : `${name}.md`;
}

export function parentOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

export function baseName(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}
