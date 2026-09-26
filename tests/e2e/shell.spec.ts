// S1 layout + ⌘J, S2 fonts, U1/U2/U4/U5/U6 statusline + popover over the fixture pool (100/40/0).
import { expect, test } from '@playwright/test';
import { bottomTerminal, createSandbox, launch, menuShortcut, screenshot, type Launched, type Sandbox } from './helpers';

test.describe.configure({ mode: 'serial' });

let sandbox: Sandbox;
let run: Launched;

test.beforeAll(async () => {
  sandbox = createSandbox();
  run = await launch(sandbox);
});

test.afterAll(async () => {
  await run?.app.close();
  sandbox?.cleanup();
});

test('3-pane layout, ⌘J toggles the terminal pane', async () => {
  const { page } = run;
  await expect(page.getByTestId('sidebar')).toBeVisible();
  await expect(page.getByTestId('chat')).toBeVisible();
  await expect(page.getByTestId('statusline')).toBeVisible();
  await expect(page.getByTestId('sidebar-nav').getByRole('button', { name: '더보기' })).toBeVisible();
  const app = page.locator('.app');
  await expect(app).toHaveClass(/app--terminal-closed/);
  await screenshot(page, '01-shell-empty');

  // No renderer keydown handler: the shortcut belongs to the menu alone (no double toggle).
  await page.keyboard.press('Meta+J');
  await page.waitForTimeout(300);
  await expect(app).toHaveClass(/app--terminal-closed/);

  await menuShortcut(run.app, 'CmdOrCtrl+J');
  await expect(app).toHaveClass(/app--terminal-open/);
  await expect.poll(async () => (await bottomTerminal(page).boundingBox())?.width ?? 0).toBeGreaterThan(300);
  await menuShortcut(run.app, 'CmdOrCtrl+J');
  await expect(app).toHaveClass(/app--terminal-closed/);
});

test('IBM Plex Sans KR UI font (statusline included), Hahmlet display and JetBrains Mono, loaded from the bundle', async () => {
  const { page } = run;
  const bodyFont = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
  expect(bodyFont).toMatch(/^"?IBM Plex Sans KR"?,/);
  expect(bodyFont).toContain('Apple SD Gothic Neo');
  const statusFont = await page.getByTestId('statusline').evaluate((el) => getComputedStyle(el).fontFamily);
  expect(statusFont).toMatch(/^"?IBM Plex Sans KR"?,/);
  // Type ramp: 14px conversation body is --text-chat, statusline 11px capsules, 13px controls.
  const sizes = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    return {
      chat: root.getPropertyValue('--text-chat').trim(),
      status: root.getPropertyValue('--text-status').trim(),
      sidebar: root.getPropertyValue('--text-md').trim(),
    };
  });
  expect(sizes).toEqual({ chat: '14px', status: '11px', sidebar: '13px' });
  expect(await page.getByTestId('statusline').evaluate((el) => getComputedStyle(el).fontSize)).toBe('11px');
  // The @font-face files actually resolved under the CSP (font-src 'self'), not a silent fallback.
  await expect
    .poll(() =>
      page.evaluate(async () => {
        await document.fonts.ready;
        const loaded = [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replace(/"/g, ''));
        return ['IBM Plex Sans KR', 'Hahmlet', 'JetBrains Mono'].every((family) => loaded.includes(family));
      }),
    )
    .toBe(true);
  await expect(page.getByTestId('brand')).toContainText('Hopecode');
});

test('statusline pool summary: 5h 47%, 2/3 avail, level colors', async () => {
  const { page } = run;
  const status = page.getByTestId('statusline');
  const fiveHour = status.locator('.hc-meter').filter({ hasText: '5h' });
  await expect(fiveHour.locator('.hc-meter__percent')).toHaveText('47%');
  await expect(status).toContainText('2/3 avail');
  // 47% is below the 70% warn threshold.
  await expect(fiveHour.locator('.hc-meter__fill')).toHaveClass(/hc-meter__fill--ok/);
  // wk avg = (62+20+5)/3 = 29%
  await expect(status.locator('.hc-meter').filter({ hasText: 'wk' }).locator('.hc-meter__percent')).toHaveText('29%');
  await screenshot(page, '02-statusline');
});

test('statusline click opens the per-account popover with an exhausted badge', async () => {
  const { page } = run;
  await page.getByTestId('statusline').locator('.hc-statusline__trigger').click();
  const pop = page.locator('.hc-accounts-pop');
  await expect(pop).toBeVisible();
  await expect(pop.locator('.hc-accounts-pop__row')).toHaveCount(3);
  for (const alias of ['Work', 'Personal', 'Spare']) {
    await expect(pop.locator('.hc-accounts-pop__alias', { hasText: alias })).toBeVisible();
  }
  const work = pop.locator('.hc-accounts-pop__row').filter({ hasText: 'Work' });
  await expect(work.locator('.hc-accounts-pop__badge')).toContainText('소진');
  // 100% meter uses the crit level color.
  await expect(work.locator('.hc-meter__fill--crit').first()).toBeVisible();
  await screenshot(page, '03-accounts-popover');
  await page.keyboard.press('Escape');
});
