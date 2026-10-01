import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveThemeRequest, scanThemeOverlay, themeUrlPath } from '../../src/main/theme/themeFiles';
import { THEME_FILE_MAX_BYTES } from '../../src/shared/theme';

let root: string;
let theme: string;
let outside: string;

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hc-theme-'));
  theme = join(root, 'home', 'theme');
  outside = join(root, 'outside');
  mkdirSync(join(theme, 'sprites'), { recursive: true });
  mkdirSync(join(theme, 'fonts'), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'secret.png'), PNG);
  writeFileSync(join(outside, 'secret.txt'), 'token');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const get = (url: string, method = 'GET') => resolveThemeRequest(theme, method, url);

describe('theme protocol containment', () => {
  it('serves an allowed file inside the folder with its content type', async () => {
    writeFileSync(join(theme, 'sprites', 'heart.png'), PNG);
    const hit = await get('hopecode-theme://theme/sprites/heart.png?v=1');
    expect(hit).toMatchObject({ ok: true, mime: 'image/png', size: PNG.length });
  });

  it('refuses every method but GET', async () => {
    writeFileSync(join(theme, 'sprites', 'heart.png'), PNG);
    for (const method of ['POST', 'PUT', 'DELETE', 'HEAD']) {
      expect(await get('hopecode-theme://theme/sprites/heart.png', method)).toEqual({ ok: false, status: 405 });
    }
  });

  it('refuses traversal: dot segments, encoded separators and encoded dots', async () => {
    for (const url of [
      'hopecode-theme://theme/../outside/secret.png',
      'hopecode-theme://theme/sprites/../../outside/secret.png',
      'hopecode-theme://theme/..%2Foutside%2Fsecret.png',
      'hopecode-theme://theme/%2e%2e/%2e%2e/outside/secret.png',
      'hopecode-theme://theme/%2E%2E%2F%2E%2E%2Foutside%2Fsecret.png',
      `hopecode-theme://theme/${encodeURIComponent(join(outside, 'secret.png'))}`,
    ]) {
      const hit = await get(url);
      expect(hit.ok, url).toBe(false);
    }
  });

  it('refuses backslashes, NUL, other hosts and other schemes', async () => {
    expect(await get('hopecode-theme://theme/sprites%5Cheart.png')).toEqual({ ok: false, status: 400 });
    expect(await get('hopecode-theme://theme/heart.png%00.png')).toEqual({ ok: false, status: 400 });
    expect(await get('hopecode-theme://evil/sprites/heart.png')).toEqual({ ok: false, status: 404 });
    expect(await get('file:///etc/passwd')).toEqual({ ok: false, status: 404 });
    expect(await get('not a url')).toEqual({ ok: false, status: 400 });
  });

  it('refuses extensions outside the image / font allowlist', async () => {
    for (const name of ['palette.json', 'x.svg', 'x.html', 'x.js', 'x.txt', 'noext']) {
      writeFileSync(join(theme, name), '{}');
      expect(await get(`hopecode-theme://theme/${name}`), name).toEqual({ ok: false, status: 403 });
    }
  });

  it('refuses a symlink that escapes the folder, even with an allowed name', async () => {
    symlinkSync(join(outside, 'secret.png'), join(theme, 'sprites', 'heart.png'));
    expect(await get('hopecode-theme://theme/sprites/heart.png')).toEqual({ ok: false, status: 403 });
    symlinkSync(outside, join(theme, 'linked'));
    expect(await get('hopecode-theme://theme/linked/secret.png')).toEqual({ ok: false, status: 403 });
  });

  it('refuses an in-folder symlink to a forbidden extension', async () => {
    writeFileSync(join(theme, 'palette.json'), '{}');
    symlinkSync(join(theme, 'palette.json'), join(theme, 'sprites', 'logo.png'));
    expect(await get('hopecode-theme://theme/sprites/logo.png')).toEqual({ ok: false, status: 403 });
  });

  it('refuses directories, missing files and oversized files', async () => {
    mkdirSync(join(theme, 'dir.png'));
    expect(await get('hopecode-theme://theme/dir.png')).toEqual({ ok: false, status: 404 });
    expect(await get('hopecode-theme://theme/missing.png')).toEqual({ ok: false, status: 404 });
    writeFileSync(join(theme, 'big.png'), Buffer.alloc(THEME_FILE_MAX_BYTES + 1));
    expect(await get('hopecode-theme://theme/big.png')).toEqual({ ok: false, status: 413 });
  });

  it('parses only the theme host and keeps the path relative', () => {
    expect(themeUrlPath('hopecode-theme://theme/fonts/ui.woff2?v=3')).toEqual({ ok: true, rel: 'fonts/ui.woff2' });
    expect(themeUrlPath('hopecode-theme://theme/')).toEqual({ ok: false, status: 404 });
    expect(themeUrlPath('hopecode-theme://user:pw@theme/x.png')).toEqual({ ok: false, status: 400 });
  });
});

describe('overlay slot detection', () => {
  it('reports an empty overlay for a missing folder', async () => {
    const overlay = await scanThemeOverlay(join(root, 'nope'));
    expect(overlay.fonts).toEqual({ ui: null, mono: null });
    expect(overlay.sprites).toEqual({ heart: null, logo: null });
    expect(overlay.palette).toBeNull();
  });

  it('finds the slots that hold a file, preferring woff2 over ttf', async () => {
    writeFileSync(join(theme, 'fonts', 'ui.ttf'), 'ttf');
    writeFileSync(join(theme, 'fonts', 'ui.woff2'), 'woff2');
    writeFileSync(join(theme, 'fonts', 'mono.otf'), 'otf');
    writeFileSync(join(theme, 'sprites', 'heart.png'), PNG);
    writeFileSync(join(theme, 'palette.json'), JSON.stringify({ '--accent': '#ff00aa', 'label': 'rgb(1, 2, 3)' }));
    const overlay = await scanThemeOverlay(theme);
    expect(overlay.fonts.ui).toMatch(/^hopecode-theme:\/\/theme\/fonts\/ui\.woff2\?v=\d+$/);
    expect(overlay.fonts.mono).toMatch(/^hopecode-theme:\/\/theme\/fonts\/mono\.otf\?v=\d+$/);
    expect(overlay.sprites.heart).toMatch(/^hopecode-theme:\/\/theme\/sprites\/heart\.png\?v=\d+$/);
    expect(overlay.sprites.logo).toBeNull();
    expect(overlay.palette).toEqual({ '--accent': '#ff00aa', '--label': 'rgb(1, 2, 3)' });
  });

  it('skips slots whose file escapes the folder and palettes that are not plain colors', async () => {
    symlinkSync(join(outside, 'secret.png'), join(theme, 'sprites', 'logo.png'));
    writeFileSync(
      join(theme, 'palette.json'),
      JSON.stringify({ '--sprite-heart': 'url(file:///etc/passwd)', '--accent': 'var(--x)', 'BAD NAME': '#fff', '--ok': 'red' }),
    );
    const overlay = await scanThemeOverlay(theme);
    expect(overlay.sprites.logo).toBeNull();
    expect(overlay.palette).toBeNull();
  });

  it('ignores a palette.json that is not JSON or links outside', async () => {
    writeFileSync(join(theme, 'palette.json'), '{ nope');
    expect((await scanThemeOverlay(theme)).palette).toBeNull();
    rmSync(join(theme, 'palette.json'));
    writeFileSync(join(outside, 'palette.json'), JSON.stringify({ '--accent': '#000' }));
    symlinkSync(join(outside, 'palette.json'), join(theme, 'palette.json'));
    expect((await scanThemeOverlay(theme)).palette).toBeNull();
  });
});
