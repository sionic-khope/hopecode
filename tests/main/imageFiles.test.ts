import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ImageAccessError,
  MAX_IMAGE_BYTES,
  changedImagesBetween,
  parsePorcelainPaths,
  readThreadImageDataUrl,
  resolveThreadImage,
  snapshotChangedImages,
} from '../../src/main/images/imageFiles';
import { MAX_CHAT_IMAGES, isChatImageList } from '../../src/main/ipc/imageHandlers';

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

let root: string;
let cwd: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hopecode-images-'));
  cwd = join(root, 'work');
  mkdirSync(join(cwd, 'assets'), { recursive: true });
  writeFileSync(join(cwd, 'assets', 'a.png'), PNG);
  writeFileSync(join(root, 'outside.png'), PNG);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('resolveThreadImage (path containment + size limit)', () => {
  it('reads an image inside the thread folder (relative or absolute)', async () => {
    expect(resolveThreadImage(cwd, 'assets/a.png').mime).toBe('image/png');
    expect(resolveThreadImage(cwd, join(cwd, 'assets/a.png')).size).toBe(PNG.length);
    expect(await readThreadImageDataUrl(cwd, 'assets/a.png')).toBe(`data:image/png;base64,${PNG.toString('base64')}`);
  });

  it('refuses paths that leave the folder: .., absolute outside, symlink escape', () => {
    expect(() => resolveThreadImage(cwd, '../outside.png')).toThrow(ImageAccessError);
    expect(() => resolveThreadImage(cwd, join(root, 'outside.png'))).toThrow(/outside/);
    symlinkSync(join(root, 'outside.png'), join(cwd, 'link.png'));
    expect(() => resolveThreadImage(cwd, 'link.png')).toThrow(/outside/);
  });

  it('refuses non-image extensions, missing files, directories, NUL and non-strings', () => {
    writeFileSync(join(cwd, 'notes.txt'), 'x');
    expect(() => resolveThreadImage(cwd, 'notes.txt')).toThrow(/not an image/);
    expect(() => resolveThreadImage(cwd, 'missing.png')).toThrow(/not found/);
    mkdirSync(join(cwd, 'dir.png'));
    expect(() => resolveThreadImage(cwd, 'dir.png')).toThrow(/not a file/);
    expect(() => resolveThreadImage(cwd, 'a\0.png')).toThrow(/invalid/);
    expect(() => resolveThreadImage(cwd, 42)).toThrow(/invalid/);
    // A symlink named .png pointing at a non-image file inside the folder is refused too.
    symlinkSync(join(cwd, 'notes.txt'), join(cwd, 'fake.png'));
    expect(() => resolveThreadImage(cwd, 'fake.png')).toThrow(/not an image/);
  });

  it('refuses files over 10 MB', () => {
    const big = join(cwd, 'big.png');
    writeFileSync(big, '');
    truncateSync(big, MAX_IMAGE_BYTES + 1);
    expect(() => resolveThreadImage(cwd, 'big.png')).toThrow(/10 MB/);
    truncateSync(big, MAX_IMAGE_BYTES);
    expect(resolveThreadImage(cwd, 'big.png').size).toBe(MAX_IMAGE_BYTES);
  });
});

describe('turn-end image detection', () => {
  it('parses porcelain -z output, skipping rename sources', () => {
    const out = [' M src/a.png', '?? new dir/b.jpg', 'R  moved.webp', 'old.webp', 'A  c.svg', ''].join('\0');
    expect(parsePorcelainPaths(out)).toEqual(['src/a.png', 'new dir/b.jpg', 'moved.webp', 'c.svg']);
  });

  it('reports images new or changed between snapshots', () => {
    const before = new Map([
      ['same.png', '1:10'],
      ['edited.png', '1:10'],
    ]);
    const after = new Map([
      ['same.png', '1:10'],
      ['edited.png', '2:12'],
      ['new.gif', '3:5'],
    ]);
    expect(changedImagesBetween(before, after)).toEqual(['edited.png', 'new.gif']);
  });

  it('snapshots changed / untracked images of a git work tree; null outside a repo', async () => {
    const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: root };
    expect(await snapshotChangedImages(cwd, env)).toBeNull();
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd });
    const before = await snapshotChangedImages(cwd, env);
    expect([...(before?.keys() ?? [])]).toEqual(['assets/a.png']);
    writeFileSync(join(cwd, 'shot.png'), PNG);
    writeFileSync(join(cwd, 'readme.md'), '# x');
    const after = await snapshotChangedImages(cwd, env);
    expect(changedImagesBetween(before!, after!)).toEqual(['shot.png']);
    expect(await snapshotChangedImages(join(root, 'nope'), env)).toBeNull();
  });
});

describe('chat:send image validation', () => {
  const image = { mediaType: 'image/png', data: 'iVBORw0KGgo=' };
  it('accepts up to 8 base64 images of the API media types', () => {
    expect(isChatImageList([image])).toBe(true);
    expect(isChatImageList(Array.from({ length: MAX_CHAT_IMAGES }, () => image))).toBe(true);
  });
  it('refuses too many, wrong types, non-base64 and oversized payloads', () => {
    expect(isChatImageList(Array.from({ length: MAX_CHAT_IMAGES + 1 }, () => image))).toBe(false);
    expect(isChatImageList([{ ...image, mediaType: 'image/svg+xml' }])).toBe(false);
    expect(isChatImageList([{ ...image, data: 'not base64!' }])).toBe(false);
    expect(isChatImageList([{ ...image, data: 'A'.repeat(7_100_000) }])).toBe(false);
    expect(isChatImageList('nope')).toBe(false);
  });
});
