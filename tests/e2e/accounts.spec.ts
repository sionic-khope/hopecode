// A1 (fixture login script), A2 alias / enabled toggle / thread pin, A3 usage chart rendered.
import { expect, test } from '@playwright/test';
import { createSandbox, launch, screenshot, sendMessage, startThread, type Launched, type Sandbox } from './helpers';

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

test('Accounts page lists the pool with usage charts', async () => {
  const { page } = run;
  await page.getByTestId('sidebar').getByRole('button', { name: /^계정/ }).click();
  const pageEl = page.locator('.hc-accounts-page');
  await expect(pageEl).toBeVisible();
  for (const alias of ['Work', 'Personal', 'Spare']) await expect(pageEl).toContainText(alias);
  await expect(pageEl.locator('svg').first()).toBeVisible();
  await expect(pageEl).toContainText('3/3 활성');
  await screenshot(page, '13-accounts-page');
});

test('+ Add Account runs the (fixture) login and fills email / plan', async () => {
  const { page } = run;
  await page.getByRole('button', { name: '+ 계정 추가' }).click();
  const dialog = page.getByRole('dialog', { name: '계정 추가' });
  await expect(dialog).toBeVisible();
  await dialog.locator('input').first().fill('Side');
  await dialog.getByRole('button', { name: '시작' }).click();
  await expect(dialog).toContainText('fixture-1@example.com', { timeout: 15_000 });
  await expect(dialog).toContainText('max');
  await screenshot(page, '14-add-account-success');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.hc-accounts-page')).toContainText('Side');
  await expect(page.locator('.hc-accounts-page')).toContainText('4/4 활성');
});

test('pinning a thread to an account runs its turns on that account', async () => {
  const { page } = run;
  await startThread(page, sandbox, '[text] 계정 고정 전');
  const pin = page.locator('.hc-composer .hc-chip--account');
  // Priority order would pick Personal (Work is exhausted); the pin forces Spare.
  await pin.click();
  await page.getByRole('menu', { name: '계정 고정' }).getByRole('menuitemradio', { name: /^Spare/ }).click();
  await expect(pin).toContainText('Spare');
  await sendMessage(page, '[whoami] pinned');
  await expect(page.locator('.hc-messages')).toContainText('account=fixture-spare');
  await expect(page.getByTestId('sidebar').locator('.hc-thread__account')).toBeVisible();
  await screenshot(page, '15-thread-pinned');
});

test('enable switch changes N/M, keyboard drag reorders priority', async () => {
  const { page } = run;
  await page.getByTestId('sidebar').getByRole('button', { name: /^계정/ }).click();
  const pageEl = page.locator('.hc-accounts-page');
  await expect(pageEl).toBeVisible();
  // The page header is the only "Accounts" title; the window bar above it stays empty.
  await expect(page.getByTestId('chat').locator('.app__titlebar')).toHaveText('');
  await expect(pageEl).toContainText('4/4 활성');

  const personalSwitch = pageEl.getByRole('switch', { name: 'Personal 활성화' });
  await personalSwitch.click();
  await expect(personalSwitch).toHaveAttribute('aria-checked', 'false');
  await expect(pageEl).toContainText('3/4 활성');
  await expect(page.getByTestId('statusline')).toContainText('/3 avail');
  await personalSwitch.click();
  await expect(personalSwitch).toHaveAttribute('aria-checked', 'true');
  await expect(pageEl).toContainText('4/4 활성');

  const aliases = pageEl.locator('.hc-acct-row__alias');
  await expect(aliases).toHaveText(['Work', 'Personal', 'Spare', 'Side']);
  // dnd-kit keyboard sensor: Space lifts, ArrowUp moves, Space drops.
  const handle = pageEl.getByRole('button', { name: 'Spare 순서 변경' });
  await handle.focus();
  await page.keyboard.press('Space');
  await expect(handle).toHaveAttribute('aria-pressed', 'true');
  // Each move re-measures the droppables; give it a frame or two between keys.
  for (let i = 0; i < 2; i++) {
    await page.waitForTimeout(200);
    await page.keyboard.press('ArrowUp');
  }
  await page.waitForTimeout(200);
  await page.keyboard.press('Space');
  await expect(aliases).toHaveText(['Spare', 'Work', 'Personal', 'Side']);
  const state = (await page.evaluate(() => window.hopecode.invoke('app:bootstrap'))) as {
    accounts: { alias: string; priority: number }[];
  };
  expect([...state.accounts].sort((a, b) => a.priority - b.priority).map((a) => a.alias)).toEqual([
    'Spare',
    'Work',
    'Personal',
    'Side',
  ]);
  await screenshot(page, '21-accounts-reordered');
});
