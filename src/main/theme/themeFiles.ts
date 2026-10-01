// Theme folder access without Electron (unit-testable): which `hopecode-theme://` request maps to which file, and which
// overlay slots hold a file. Every path is checked twice -- lexically against the folder, then again after realpath --
// so `..`, encoded separators and symlinks that point out of the folder are all refused.
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { isStrictlyInside } from '../containment';
import {
  THEME_FILE_MAX_BYTES,
  THEME_FONT_EXTENSIONS,
  THEME_HOST,
  THEME_MIME,
  THEME_PALETTE_MAX_BYTES,
  THEME_SCHEME,
  THEME_SOUND_EXTENSIONS,
  THEME_SOUND_SLOTS,
  THEME_SPRITE_EXTENSIONS,
  sanitizePalette,
  type ThemeOverlay,
} from '../../shared/theme';

export type ThemeResolution =
  | { ok: true; path: string; mime: string; size: number; mtimeMs: number }
  | { ok: false; status: 400 | 403 | 404 | 405 | 413 };

/** Theme folder of an app data dir (`hopecodeHome()/theme`). */
export function themeDirOf(home: string): string {
  return join(home, 'theme');
}

/** The relative path of a theme URL (`hopecode-theme://theme/<rel>`), or a refusal status. */
export function themeUrlPath(url: string): { ok: true; rel: string } | { ok: false; status: 400 | 404 } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, status: 400 };
  }
  if (parsed.protocol !== `${THEME_SCHEME}:` || parsed.hostname !== THEME_HOST) return { ok: false, status: 404 };
  if (parsed.username || parsed.password || parsed.port) return { ok: false, status: 400 };
  let rel: string;
  try {
    rel = decodeURIComponent(parsed.pathname);
  } catch {
    return { ok: false, status: 400 };
  }
  // Backslashes and NUL never name a file here; leading slashes are the URL's own.
  if (rel.includes('\0') || rel.includes('\\')) return { ok: false, status: 400 };
  rel = rel.replace(/^\/+/, '');
  if (rel === '') return { ok: false, status: 404 };
  return { ok: true, rel };
}

/** Content type of an allowed extension, or null. */
export function themeMime(path: string): string | null {
  const ext = extname(path).slice(1).toLowerCase();
  return Object.prototype.hasOwnProperty.call(THEME_MIME, ext) ? THEME_MIME[ext]! : null;
}

/**
 * Resolves a relative path inside `themeDir` to a servable file: allowed extension, strictly inside the folder both
 * lexically and after following symlinks, a regular file of at most THEME_FILE_MAX_BYTES.
 */
export async function resolveThemeFile(themeDir: string, rel: string): Promise<ThemeResolution> {
  const mime = themeMime(rel);
  if (!mime) return { ok: false, status: 403 };
  const root = resolve(themeDir);
  const abs = resolve(root, rel);
  if (!isStrictlyInside(root, abs)) return { ok: false, status: 403 };
  let realRoot: string;
  let realFile: string;
  try {
    realRoot = await realpath(root);
    realFile = await realpath(abs);
  } catch {
    return { ok: false, status: 404 };
  }
  if (!isStrictlyInside(realRoot, realFile)) return { ok: false, status: 403 };
  // The symlink target must keep an allowed extension too (a link named heart.png must not serve a .json).
  if (!themeMime(realFile)) return { ok: false, status: 403 };
  try {
    const st = await stat(realFile);
    if (!st.isFile()) return { ok: false, status: 404 };
    if (st.size > THEME_FILE_MAX_BYTES) return { ok: false, status: 413 };
    return { ok: true, path: realFile, mime, size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return { ok: false, status: 404 };
  }
}

/** A `hopecode-theme://` request -> the file to serve, or the status to refuse it with. GET only. */
export async function resolveThemeRequest(themeDir: string, method: string, url: string): Promise<ThemeResolution> {
  if (method !== 'GET') return { ok: false, status: 405 };
  const path = themeUrlPath(url);
  if (!path.ok) return path;
  return resolveThemeFile(themeDir, path.rel);
}

/** `hopecode-theme://theme/<rel>?v=<mtime>`: the mtime busts the renderer cache after a file is replaced. */
export function themeUrl(rel: string, mtimeMs: number): string {
  const encoded = rel.split('/').map(encodeURIComponent).join('/');
  return `${THEME_SCHEME}://${THEME_HOST}/${encoded}?v=${Math.floor(mtimeMs)}`;
}

async function firstSlot(themeDir: string, base: string, exts: readonly string[]): Promise<string | null> {
  for (const ext of exts) {
    const rel = `${base}.${ext}`;
    const hit = await resolveThemeFile(themeDir, rel);
    if (hit.ok) return themeUrl(rel, hit.mtimeMs);
  }
  return null;
}

async function readPalette(themeDir: string): Promise<Record<string, string> | null> {
  const root = resolve(themeDir);
  const abs = join(root, 'palette.json');
  try {
    const [realRoot, realFile] = await Promise.all([realpath(root), realpath(abs)]);
    if (!isStrictlyInside(realRoot, realFile)) return null;
    const st = await stat(realFile);
    if (!st.isFile() || st.size > THEME_PALETTE_MAX_BYTES) return null;
    return sanitizePalette(JSON.parse(await readFile(realFile, 'utf8')) as unknown);
  } catch {
    return null;
  }
}

/** Which overlay slots of `themeDir` hold a usable file. A missing folder is simply an empty overlay. */
export async function scanThemeOverlay(themeDir: string): Promise<ThemeOverlay> {
  const [ui, mono, heart, logo, palette, sounds] = await Promise.all([
    firstSlot(themeDir, 'fonts/ui', THEME_FONT_EXTENSIONS),
    firstSlot(themeDir, 'fonts/mono', THEME_FONT_EXTENSIONS),
    firstSlot(themeDir, 'sprites/heart', THEME_SPRITE_EXTENSIONS),
    firstSlot(themeDir, 'sprites/logo', THEME_SPRITE_EXTENSIONS),
    readPalette(themeDir),
    Promise.all(THEME_SOUND_SLOTS.map(async (slot) => [slot, await firstSlot(themeDir, `sounds/${slot}`, THEME_SOUND_EXTENSIONS)] as const)),
  ]);
  return {
    dir: resolve(themeDir),
    fonts: { ui, mono },
    sprites: { heart, logo },
    sounds: Object.fromEntries(sounds) as ThemeOverlay['sounds'],
    palette,
  };
}
