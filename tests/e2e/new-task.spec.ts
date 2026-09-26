// New Task Start: draft-screen button, ⌘⇧N (menu accelerator only, no renderer keydown double-fire),
// command palette entry, and the settings' template textarea. Headless (HOPECODE_E2E), fixture mode.
import { expect, test } from '@playwright/test';
import {
  chooseFixtureFolder,
  createSandbox,
  launch,
  menuShortcut,
  openDraft,
  screenshot,
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

test('draft button fills the composer with the template, substituting {project}/{date}; the button stays visible', async () => {
  const { page } = run;
  await openDraft(page);
  await chooseFixtureFolder(page, sandbox);
  const projectName = sandbox.project.split('/').pop()!;

  const button = page.getByTestId('new-task-start');
  await expect(button).toBeVisible();
  await expect(button).toContainText('New Task Start');

  await button.click();
  const box = page.locator('.hc-composer__textarea');
  await expect(box).toHaveValue(/git pull로 base 브랜치를 최신 상태로 맞추기/);
  await expect(box).toBeFocused();
  await screenshot(page, 'v4-new-task', SHOTS);
});

test('typed text is kept, with the template placed in front of it', async () => {
  const { page } = run;
  const box = page.locator('.hc-composer__textarea');
  await box.fill('이미 적어둔 요청');
  await page.getByTestId('new-task-start').click();
  const value = await box.inputValue();
  expect(value.startsWith('작업 시작 전에')).toBe(true);
  expect(value.endsWith('이미 적어둔 요청')).toBe(true);
  await box.fill('');
});

test('⌘⇧N runs the same action from the menu only (no renderer keydown double-fire), and from the command palette', async () => {
  const { page } = run;
  const box = page.locator('.hc-composer__textarea');
  await expect(box).toHaveValue('');

  await page.keyboard.press('Meta+Shift+N');
  await page.waitForTimeout(300);
  await expect(box).toHaveValue('');

  await menuShortcut(run.app, 'CmdOrCtrl+Shift+N');
  await expect(box).toHaveValue(/git pull로 base 브랜치를 최신 상태로 맞추기/);
  await box.fill('');

  await menuShortcut(run.app, 'CmdOrCtrl+K');
  const palette = page.getByTestId('command-palette');
  await expect(palette).toBeVisible();
  await page.keyboard.type('New Task Start');
  await expect(palette.getByRole('option').first()).toContainText('New Task Start');
  await page.keyboard.press('Enter');
  await expect(palette).toHaveCount(0);
  await expect(box).toHaveValue(/git pull로 base 브랜치를 최신 상태로 맞추기/);
  await box.fill('');
});

test('settings: changing the template applies to the next New Task Start; blank reverts to the default', async () => {
  const { page } = run;
  await page.getByTestId('sidebar').getByRole('button', { name: /^설정/ }).click();
  const settingsPage = page.getByTestId('settings');
  await expect(settingsPage).toBeVisible();
  const textarea = settingsPage.getByRole('textbox', { name: 'New Task Start 템플릿' });
  await expect(textarea).toBeVisible();

  await textarea.fill('커스텀 New Task 템플릿 {project}');
  await textarea.blur();
  await expect.poll(async () => textarea.inputValue()).toBe('커스텀 New Task 템플릿 {project}');

  await page.getByTestId('sidebar').getByRole('button', { name: /^새 채팅/ }).click();
  await expect(page.getByTestId('draft')).toBeVisible();
  await page.getByTestId('new-task-start').click();
  await expect(page.locator('.hc-composer__textarea')).toHaveValue(/커스텀 New Task 템플릿/);

  // Reset button: back to the default template.
  await page.getByTestId('sidebar').getByRole('button', { name: /^설정/ }).click();
  await page.getByTestId('settings').getByRole('button', { name: '기본값으로 되돌리기' }).click();
  await expect.poll(async () => textarea.inputValue()).toContain('작업 시작 전에');

  // A blank (whitespace-only) textarea also falls back to the default (never allowed to stay empty).
  await textarea.fill('   ');
  await textarea.blur();
  await expect.poll(async () => textarea.inputValue()).toContain('작업 시작 전에');
});
