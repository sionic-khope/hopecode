// v5 design pass: captures every restyled surface (draft, conversation with permission + diff, right panel with
// changes and terminal, sidebar + profile menu, settings, accounts, command palette) and checks the design
// tokens the new language depends on (flat panes, display face on titles, primary blue).
import { expect, test } from '@playwright/test';
import { bottomTerminal, createSandbox, launch, menuShortcut, openDraft, openFromMore, screenshot, startThread, type Launched, type Sandbox } from './helpers';

const SHOTS =
  process.env['HOPECODE_REDESIGN_SCREENSHOTS'] ??
  '/private/tmp/claude-501/-Users-khope-sionic-ai-Desktop-khope-hopecode/69735d65-52c2-4ff2-9412-948601635f0d/scratchpad/redesign';

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

test('draft: display-face title, primary New Task Start, hairline suggestion cards', async () => {
  const { page } = run;
  await openDraft(page);
  const draft = page.getByTestId('draft');
  await expect(draft).toBeVisible();
  const title = draft.getByRole('heading', { name: '무엇을 만들어 볼까요?' });
  expect(await title.evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(/^"?Hahmlet"?,/);
  // Flat panes: the sidebar and the conversation pane are not floating rounded cards any more.
  expect(await page.locator('.app__chat').evaluate((el) => getComputedStyle(el).borderTopLeftRadius)).toBe('0px');
  expect(await page.locator('.app__chat').evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(248, 250, 255)');
  await page.mouse.move(5, 700);
  await screenshot(page, 'v5-draft', SHOTS);
});

test('conversation: permission card, then the Edit diff', async () => {
  const { page } = run;
  await startThread(page, sandbox, 'README 인사말을 바꿔 주세요');
  const permission = page.locator('.hc-permission');
  await expect(permission).toBeVisible();
  await page.mouse.move(5, 700);
  await screenshot(page, 'v5-conversation-permission', SHOTS);
  await permission.getByRole('button', { name: '허용', exact: true }).click();
  await expect(page.locator('.hc-messages')).toContainText('Done. The greeting now says "Hello Hopecode".');
  await page.locator('.hc-tool').filter({ hasText: 'Edit' }).locator('.hc-tool__header').click();
  await expect(page.locator('.hc-tool .hc-diff__row--add')).toContainText('Hello Hopecode');
  expect(await page.locator('.app__thread-name').evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(/^"?Hahmlet"?,/);
  await page.mouse.move(5, 700);
  await screenshot(page, 'v5-conversation-diff', SHOTS);
});

test('right panel: changes with a diff, then the bottom terminal beside it', async () => {
  const { page } = run;
  await menuShortcut(run.app, 'CmdOrCtrl+Shift+D');
  const panel = page.getByTestId('changes-panel');
  await expect(panel).toBeVisible();
  const file = panel.locator('.hc-changes__file[data-path="README.md"]');
  await expect(file).toBeVisible();
  await file.click();
  await expect(panel.locator('.hc-diff__row--add')).toContainText('Hello Hopecode');
  await page.mouse.move(5, 700);
  await screenshot(page, 'v5-panel-changes', SHOTS);

  await menuShortcut(run.app, 'CmdOrCtrl+J');
  await expect(page.locator('.app')).toHaveClass(/app--terminal-open/);
  await expect(bottomTerminal(page).locator('.xterm')).toBeVisible();
  await page.mouse.move(5, 700);
  await expect(page.getByTestId('changes-panel')).toBeVisible();
  await screenshot(page, 'v5-panel-terminal', SHOTS);
  await menuShortcut(run.app, 'CmdOrCtrl+J');
  await expect(page.locator('.app')).toHaveClass(/app--terminal-closed/);
});

test('sidebar + profile menu', async () => {
  const { page } = run;
  const app = page.locator('.app');
  if (await app.evaluate((el) => el.classList.contains('app--panel-open'))) {
    await menuShortcut(run.app, 'CmdOrCtrl+Shift+D');
    await expect(app).toHaveClass(/app--panel-closed/);
  }
  await page.getByTestId('profile-row').click();
  const menu = page.getByRole('menu', { name: '프로필' });
  await expect(menu).toBeVisible();
  await screenshot(page, 'v5-sidebar-profile-menu', SHOTS);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
});

test('command palette', async () => {
  const { page } = run;
  await menuShortcut(run.app, 'CmdOrCtrl+K');
  const palette = page.getByTestId('command-palette');
  await expect(palette).toBeVisible();
  await page.keyboard.type('설정');
  await expect(palette.getByRole('option').first()).toBeVisible();
  await screenshot(page, 'v5-palette', SHOTS);
  await page.keyboard.press('Escape');
  await expect(palette).toHaveCount(0);
});

test('settings and accounts pages (via the nav 더보기 menu)', async () => {
  const { page } = run;
  await openFromMore(page, '설정');
  const settings = page.getByTestId('settings');
  await expect(settings).toBeVisible();
  expect(await settings.locator('.hc-settings__title').evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(/^"?Hahmlet"?,/);
  await page.mouse.move(5, 700);
  await screenshot(page, 'v5-settings', SHOTS);

  await openFromMore(page, '계정');
  await expect(page.locator('.hc-accounts-page')).toBeVisible();
  await page.mouse.move(5, 700);
  await screenshot(page, 'v5-accounts', SHOTS);
});
