// Image files of a thread folder: turn-end detection (git status) and reads for the renderer (data URLs).
// Paths from the renderer are never trusted: every read resolves real paths and must stay inside the thread cwd.
import { execFile } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, isAbsolute, join, resolve } from 'node:path';
import { isStrictlyInside } from '../containment';

/** Largest image file main reads for the renderer. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export const IMAGE_MIME_BY_EXT: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

/** At most this many images per turn-end gallery (newest changes first by path order). */
export const MAX_GALLERY_IMAGES = 24;

export function isImagePath(path: string): boolean {
  return Object.hasOwn(IMAGE_MIME_BY_EXT, extname(path).toLowerCase());
}

export class ImageAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageAccessError';
  }
}

/**
 * Absolute real path of image `path` inside `cwd` (relative, or absolute but inside). Refuses anything outside the
 * folder (`..`, symlinks pointing out), non-image extensions, non-files and files over MAX_IMAGE_BYTES.
 */
export function resolveThreadImage(cwd: string, path: unknown): { abs: string; mime: string; size: number } {
  if (typeof path !== 'string' || path.length === 0 || path.length > 4096 || path.includes('\0')) {
    throw new ImageAccessError('invalid image path');
  }
  const mime = IMAGE_MIME_BY_EXT[extname(path).toLowerCase()];
  if (!mime) throw new ImageAccessError('not an image file');
  let root: string;
  let abs: string;
  try {
    root = realpathSync(cwd);
    abs = realpathSync(isAbsolute(path) ? path : join(root, path));
  } catch {
    throw new ImageAccessError('image not found');
  }
  if (!isStrictlyInside(root, abs)) throw new ImageAccessError('image outside the thread folder');
  if (!IMAGE_MIME_BY_EXT[extname(abs).toLowerCase()]) throw new ImageAccessError('not an image file');
  const stat = statSync(abs);
  if (!stat.isFile()) throw new ImageAccessError('not a file');
  if (stat.size > MAX_IMAGE_BYTES) throw new ImageAccessError('image larger than 10 MB');
  return { abs, mime, size: stat.size };
}

export async function readThreadImage(cwd: string, path: unknown): Promise<{ abs: string; mime: string; buffer: Buffer }> {
  const { abs, mime } = resolveThreadImage(cwd, path);
  const buffer = await readFile(abs);
  if (buffer.length > MAX_IMAGE_BYTES) throw new ImageAccessError('image larger than 10 MB');
  return { abs, mime, buffer };
}

export async function readThreadImageDataUrl(cwd: string, path: unknown): Promise<string> {
  const { mime, buffer } = await readThreadImage(cwd, path);
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

/** Image path -> `mtime:size` signature of every changed / untracked image `git status` reports in `cwd`. */
export type ImageSnapshot = Map<string, string>;

/** Paths of `git status --porcelain=v1 -z` output (rename / copy sources skipped). */
export function parsePorcelainPaths(out: string): string[] {
  const tokens = out.split('\0');
  const paths: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i];
    if (!entry || entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    paths.push(entry.slice(3));
    if (xy.includes('R') || xy.includes('C')) i += 1;
  }
  return paths;
}

/** Snapshot of changed image files in the thread folder; null when it is not a git work tree (or git failed). */
export function snapshotChangedImages(cwd: string, env: Record<string, string>): Promise<ImageSnapshot | null> {
  if (!existsSync(cwd)) return Promise.resolve(null);
  return new Promise((done) => {
    execFile(
      'git',
      ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
      { cwd, env, maxBuffer: 16 * 1024 * 1024, timeout: 15_000 },
      (err, stdout) => {
        if (err) return done(null);
        const snapshot: ImageSnapshot = new Map();
        for (const rel of parsePorcelainPaths(String(stdout))) {
          if (!isImagePath(rel)) continue;
          try {
            const stat = statSync(resolve(cwd, rel));
            if (stat.isFile()) snapshot.set(rel, `${stat.mtimeMs}:${stat.size}`);
          } catch {
            // Deleted in the work tree: nothing to show.
          }
        }
        done(snapshot);
      },
    );
  });
}

/** Images new in `after` or whose signature changed since `before`. */
export function changedImagesBetween(before: ImageSnapshot, after: ImageSnapshot): string[] {
  const changed: string[] = [];
  for (const [path, sig] of after) if (before.get(path) !== sig) changed.push(path);
  return changed.sort().slice(0, MAX_GALLERY_IMAGES);
}
