// Local theme overlay: files dropped into HOPECODE_HOME/home/theme replace the bundled slots (ui font, heart sprite,
// logo, palette tokens) through the hopecode-theme:// protocol; anything outside the folder never loads.
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { ROOT, createSandbox, launch, screenshot, type Launched, type Sandbox } from './helpers';

const SHOTS =
  process.env['HOPECODE_REDESIGN_SCREENSHOTS'] ??
  '/private/tmp/claude-501/-Users-khope-sionic-ai-Desktop-khope-hopecode/69735d65-52c2-4ff2-9412-948601635f0d/scratchpad/redesign';

test.describe.configure({ mode: 'serial' });

let sandbox: Sandbox;
let run: Launched;

test.beforeAll(async () => {
  sandbox = createSandbox();
  const theme = join(sandbox.home, 'home', 'theme');
  mkdirSync(join(theme, 'fonts'), { recursive: true });
  mkdirSync(join(theme, 'sprites'), { recursive: true });
  // Any real font / image will do: the bundled Silkscreen as the "ui" font, the app icon as heart and logo.
  copyFileSync(join(ROOT, 'src/renderer/assets/fonts/Silkscreen-Regular.ttf'), join(theme, 'fonts', 'ui.ttf'));
  copyFileSync(join(ROOT, 'build/icon.png'), join(theme, 'sprites', 'heart.png'));
  copyFileSync(join(ROOT, 'build/icon.png'), join(theme, 'sprites', 'logo.png'));
  writeFileSync(join(theme, 'palette.json'), JSON.stringify({ '--accent': '#00ff88', '--sprite-heart': 'url(x)' }));
  // A file next to (not inside) the theme folder: reachable only by traversal, which must fail.
  copyFileSync(join(ROOT, 'build/icon.png'), join(sandbox.home, 'home', 'outside.png'));
  run = await launch(sandbox);
});

test.afterAll(async () => {
  await run?.app.close();
  sandbox?.cleanup();
});

test('overlay slots replace the bundled font, heart, logo and palette tokens', async () => {
  const { page } = run;
  await expect(page.locator('html')).toHaveAttribute('data-theme-overlay', 'palette ui heart logo');
  const root = await page.evaluate(() => {
    const s = getComputedStyle(document.documentElement);
    return {
      accent: s.getPropertyValue('--accent').trim(),
      fontUi: s.getPropertyValue('--font-ui').trim(),
      fontChat: s.getPropertyValue('--font-chat').trim(),
      heart: s.getPropertyValue('--sprite-heart').trim(),
    };
  });
  expect(root.accent).toBe('#00ff88');
  expect(root.fontUi).toMatch(/^'Hopecode Overlay UI', 'Galmuri11'/);
  expect(root.fontChat).toMatch(/^'Hopecode Overlay UI', 'Galmuri14'/);
  // The palette may only set colors: its url() for the heart was dropped, the heart comes from the sprite slot.
  expect(root.heart).toMatch(/^url\("hopecode-theme:\/\/theme\/sprites\/heart\.png\?v=\d+"\)$/);
  // The overlay face really loaded over the protocol (CORS + CSP font-src).
  await expect
    .poll(() =>
      page.evaluate(() => [...document.fonts].some((f) => f.family.replace(/["']/g, '') === 'Hopecode Overlay UI' && f.status === 'loaded')),
    )
    .toBe(true);
  expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toMatch(/^"?Hopecode Overlay UI"?,/);
  // Logo slot: an <img> over the protocol in place of the pixel mark, actually decoded.
  const logo = page.getByTestId('brand').locator('img[data-overlay="logo"]');
  await expect(logo).toHaveAttribute('src', /^hopecode-theme:\/\/theme\/sprites\/logo\.png\?v=\d+$/);
  await expect.poll(() => logo.evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await expect(page.getByTestId('brand')).toContainText('Hopecode');
  await screenshot(page, 'v12-overlay', SHOTS);
});

test('the protocol never serves anything outside the folder or a non-image / font file', async () => {
  const { page } = run;
  const loads = await page.evaluate(async () => {
    const tryImg = (src: string) =>
      new Promise<boolean>((resolve) => {
        const img = new Image();
        img.onload = () => resolve(true);
        img.onerror = () => resolve(false);
        img.src = src;
      });
    return {
      inside: await tryImg('hopecode-theme://theme/sprites/heart.png'),
      dotdot: await tryImg('hopecode-theme://theme/../outside.png'),
      encoded: await tryImg('hopecode-theme://theme/..%2Foutside.png'),
      json: await tryImg('hopecode-theme://theme/palette.json'),
      otherHost: await tryImg('hopecode-theme://elsewhere/sprites/heart.png'),
    };
  });
  expect(loads).toEqual({ inside: true, dotdot: false, encoded: false, json: false, otherHost: false });
});
