// v12 "Dark World": the pixel RPG theme on every surface. Captures draft, conversation (dialogue box + tool + diff),
// the PARTY line, a menu with the heart cursor, the error card, settings, accounts, the bottom terminal and the command
// palette, and checks the tokens the language depends on (black panes, pixel faces, yellow primary and selection).
import { expect, test, type Page } from '@playwright/test';
import {
  bottomTerminal,
  chooseFixtureFolder,
  createSandbox,
  launch,
  menuShortcut,
  openDraft,
  openFromMore,
  pickAgent,
  screenshot,
  sendMessage,
  startThread,
  type Launched,
  type Sandbox,
} from './helpers';

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

const messages = (page: Page) => page.locator('.hc-messages');
const style = (page: Page, selector: string, prop: string, pseudo?: string) =>
  page.locator(selector).first().evaluate((el, [p, ps]) => getComputedStyle(el, ps ?? null).getPropertyValue(p!), [prop, pseudo] as const);

test('draft: black world, pixel faces, DELTAX lockup and the pixel mark', async () => {
  const { page } = run;
  await openDraft(page);
  const draft = page.getByTestId('draft');
  await expect(draft).toBeVisible();
  expect(await style(page, 'body', 'background-color')).toBe('rgb(0, 0, 0)');
  expect(await style(page, '.app__chat', 'background-color')).toBe('rgb(7, 5, 12)');
  expect(await style(page, 'body', 'font-family')).toMatch(/^"?Galmuri11"?,/);
  expect(await style(page, '.hc-draft__title', 'font-family')).toMatch(/^"?Galmuri11"?,/);
  expect(await style(page, '.hc-draft__title', 'font-weight')).toBe('700');
  expect(await style(page, '.hc-sidebar__wordmark', 'font-family')).toMatch(/^"?Silkscreen"?,/);
  expect(await style(page, '.hc-sidebar__wordmark', 'text-transform')).toBe('uppercase');
  expect(await style(page, '.hc-sidebar__wordmark-code', 'color')).toBe('rgb(255, 225, 77)');
  // The mark is the 16-cell pixel drawing, snapped to 32px in the sidebar and 64px on the draft.
  await expect(page.getByTestId('brand').locator('svg.hc-brand-mark')).toHaveAttribute('width', '32');
  await expect(draft.locator('.hc-draft__mark svg.hc-brand-mark')).toHaveAttribute('width', '64');
  // The selected nav row ("새 채팅") is yellow and carries the heart.
  const compose = page.getByTestId('sidebar').getByRole('button', { name: /^새 채팅/ });
  expect(await compose.evaluate((el) => getComputedStyle(el).color)).toBe('rgb(255, 225, 77)');
  expect(await compose.evaluate((el) => getComputedStyle(el, '::before').opacity)).toBe('1');
  await page.mouse.move(5, 700);
  await screenshot(page, 'v12-draft', SHOTS);
});

test('conversation: dialogue box with the * CLAUDE tag, yellow user box, framed tool card and the diff', async () => {
  const { page } = run;
  await startThread(page, sandbox, 'README 인사말을 바꿔 주세요');
  const permission = page.locator('.hc-permission');
  await expect(permission).toBeVisible();
  await permission.getByRole('button', { name: '허용', exact: true }).click();
  await expect(messages(page)).toContainText('Done. The greeting now says "Hello deltax".');
  await page.locator('.hc-tool').filter({ hasText: 'Edit' }).locator('.hc-tool__header').click();
  await expect(page.locator('.hc-tool .hc-diff__row--add')).toContainText('Hello deltax');

  const say = messages(page).locator('.hc-say--lead').first();
  await expect(say.locator('.hc-agent-name')).toHaveText('Claude');
  expect(await say.locator('.hc-agent-name').evaluate((el) => getComputedStyle(el).textTransform)).toBe('uppercase');
  expect(await say.locator('.hc-agent-name').evaluate((el) => getComputedStyle(el, '::before').content)).toBe('"* "');
  expect(await say.evaluate((el) => getComputedStyle(el).borderTopColor)).toBe('rgb(255, 255, 255)');
  expect(await style(page, '.hc-msg-assistant', 'font-family')).toMatch(/^"?Galmuri14"?,/);
  expect(await style(page, '.hc-msg-assistant', 'font-size')).toBe('15px');
  expect(await style(page, '.hc-msg-user__bubble', 'box-shadow')).toContain('rgb(255, 225, 77)');
  expect(await style(page, '.hc-agent-avatar', 'width')).toBe('44px');
  expect(await style(page, '.hc-diff__row--add', 'background-color')).toBe('rgb(10, 34, 20)');
  expect(await style(page, '.hc-diff__row--del', 'color')).toBe('rgb(255, 196, 202)');
  expect(await style(page, '.app__thread-name', 'font-family')).toMatch(/^"?Galmuri11"?,/);
  // The selected thread: yellow frame, yellow text, heart cursor.
  const row = page.getByTestId('sidebar').locator('.hc-thread--selected');
  expect(await row.evaluate((el) => getComputedStyle(el).color)).toBe('rgb(255, 225, 77)');
  expect(await row.evaluate((el) => getComputedStyle(el, '::before').opacity)).toBe('1');
  await page.mouse.move(5, 700);
  await screenshot(page, 'v12-conversation', SHOTS);
});

test('statusline: HP (5h) and TP (ctx) gauges', async () => {
  const { page } = run;
  const status = page.getByTestId('statusline');
  const hp = status.locator('.hc-meter--hp');
  await expect(hp.locator('.hc-meter__gauge')).toHaveText('HP');
  await expect(hp.locator('.hc-meter__label')).toHaveText('5h');
  expect(await hp.locator('.hc-meter__track').evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(107, 15, 26)');
  expect(await hp.locator('.hc-meter__fill').evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(255, 225, 77)');
  const tp = status.locator('.hc-meter--tp');
  await expect(tp.locator('.hc-meter__gauge')).toHaveText('TP');
  await expect(tp.locator('.hc-meter__label')).toHaveText('ctx');
});

test('subagents: the PARTY line with re-inked characters', async () => {
  const { page } = run;
  await sendMessage(page, '[subagents] 저장소 조사');
  const routing = messages(page).getByTestId('subagent-routing');
  await expect(routing).toContainText('PARTY');
  await expect(messages(page)).toContainText('두 서브에이전트가 모두 끝났습니다', { timeout: 15_000 });
  // Outline ink of the sprites is the pale lavender, visible on black.
  const ink = await routing.locator('.hc-sprite__svg rect').evaluateAll((rects) => rects.map((r) => r.getAttribute('fill')));
  expect(ink).toContain('#E9E2FF');
  await routing.scrollIntoViewIfNeeded();
  await page.mouse.move(5, 700);
  await screenshot(page, 'v12-party', SHOTS);
});

test('menu: framed popover, the heart on the checked item, hard gray drop', async () => {
  const { page } = run;
  await openDraft(page);
  await page.getByTestId('draft').locator('.hc-chip--folder').click();
  const menu = page.getByRole('menu', { name: '폴더' });
  await expect(menu).toBeVisible();
  const checked = menu.getByRole('menuitemradio', { checked: true }).first();
  await page.mouse.move(5, 700);
  expect(await checked.evaluate((el) => getComputedStyle(el).color)).toBe('rgb(255, 225, 77)');
  expect(await checked.evaluate((el) => getComputedStyle(el, '::before').opacity)).toBe('1');
  const shadow = await page.locator('.hc-popover').filter({ has: menu }).evaluate((el) => getComputedStyle(el).boxShadow);
  expect(shadow).toContain('rgb(255, 255, 255)');
  expect(shadow).toContain('rgb(58, 58, 58)');
  await screenshot(page, 'v12-menu', SHOTS);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
});

test('error card: crit frame', async () => {
  const { page } = run;
  await openDraft(page);
  await pickAgent(page, 'Codex');
  await chooseFixtureFolder(page, sandbox);
  await sendMessage(page, '/crash');
  const card = messages(page).getByTestId('error-card').last();
  await expect(card).toHaveAttribute('data-kind', 'crash');
  expect(await card.evaluate((el) => getComputedStyle(el).boxShadow)).toContain('rgb(255, 59, 78)');
  await expect(messages(page).locator('.hc-agent-name').first()).toHaveText('Codex');
  await card.getByRole('button', { name: '자세히 보기' }).click();
  await card.getByTestId('error-raw').scrollIntoViewIfNeeded();
  await page.mouse.move(5, 700);
  await screenshot(page, 'v12-error-card', SHOTS);
});

test('bottom terminal: black xterm with the yellow cursor', async () => {
  const { page } = run;
  await menuShortcut(run.app, 'CmdOrCtrl+J');
  await expect(page.locator('.app')).toHaveClass(/app--terminal-open/);
  const term = bottomTerminal(page);
  await expect(term.locator('.xterm')).toBeVisible();
  expect(await term.locator('.hc-terminal').evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(0, 0, 0)');
  await page.mouse.move(5, 700);
  await screenshot(page, 'v12-terminal', SHOTS);
  await menuShortcut(run.app, 'CmdOrCtrl+J');
  await expect(page.locator('.app')).toHaveClass(/app--terminal-closed/);
});

test('command palette: the heart on the active result', async () => {
  const { page } = run;
  await menuShortcut(run.app, 'CmdOrCtrl+K');
  const palette = page.getByTestId('command-palette');
  await expect(palette).toBeVisible();
  await page.keyboard.type('설정');
  const active = palette.locator('.hc-palette__item--active');
  await expect(active).toHaveCount(1);
  expect(await active.evaluate((el) => getComputedStyle(el, '::before').opacity)).toBe('1');
  await screenshot(page, 'v12-palette', SHOTS);
  await page.keyboard.press('Escape');
  await expect(palette).toHaveCount(0);
});

test('settings and accounts pages', async () => {
  const { page } = run;
  await openFromMore(page, '설정');
  const settings = page.getByTestId('settings');
  await expect(settings).toBeVisible();
  expect(await settings.locator('.hc-settings__title').evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(/^"?Galmuri11"?,/);
  await page.mouse.move(5, 700);
  await screenshot(page, 'v12-settings', SHOTS);

  await openFromMore(page, '계정');
  await expect(page.locator('.hc-accounts-page')).toBeVisible();
  await page.mouse.move(5, 700);
  await screenshot(page, 'v12-accounts', SHOTS);
});
