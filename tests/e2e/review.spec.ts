// Review-fix coverage: H2 한글 IME Enter, L10 thread rename / delete (+ dirty worktree force), M8 terminal
// exit -> Restart, project trust badge, T5 permission modes reaching the session, M7 permission card survives
// a renderer reload.
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import {
  addProjectAndThread,
  bootstrapState,
  createSandbox,
  launch,
  menuShortcut,
  screenshot,
  sendMessage,
  type Launched,
  type Sandbox,
} from './helpers';

test.describe.configure({ mode: 'serial' });

let sandbox: Sandbox;
let run: Launched;

test.beforeAll(async () => {
  sandbox = createSandbox();
  run = await launch(sandbox);
  await addProjectAndThread(run.page);
});

test.afterAll(async () => {
  await run?.app.close();
  sandbox?.cleanup();
});

test('한글 IME: Enter that commits a composition does not send; the next Enter does', async () => {
  const { page } = run;
  const box = page.locator('.hc-composer__textarea');
  await box.click();
  await page.keyboard.insertText('[text] 안녕하세요');
  // The keydown Chromium delivers while the IME still owns Enter (isComposing / keyCode 229).
  await box.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, isComposing: true, bubbles: true });
  await box.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, isComposing: true, bubbles: true });
  await page.waitForTimeout(300);
  await expect(page.locator('.hc-msg-user__bubble')).toHaveCount(0);
  await expect(box).toHaveValue('[text] 안녕하세요');

  await box.press('Enter');
  await expect(page.locator('.hc-msg-user__bubble')).toHaveText('[text] 안녕하세요');
  await expect(box).toHaveValue('');
  await expect(page.locator('.hc-messages')).toContainText('Streaming reply from the fixture session.');
});

test('permission modes: Plan / Accept Edits reach the next turn; Bypass goes through the confirm seam', async () => {
  const { page } = run;
  const modes = page.getByRole('radiogroup', { name: 'Permission mode' });
  const messages = page.locator('.hc-messages');

  await modes.getByRole('radio', { name: 'Plan' }).click();
  await expect(modes.getByRole('radio', { name: 'Plan' })).toHaveAttribute('aria-checked', 'true');
  await sendMessage(page, '[whoami] plan');
  await expect(messages).toContainText('permissionMode=plan');

  await modes.getByRole('radio', { name: 'Accept Edits' }).click();
  await expect(modes.getByRole('radio', { name: 'Accept Edits' })).toHaveAttribute('aria-checked', 'true');
  await sendMessage(page, '[whoami] acceptEdits');
  await expect(messages).toContainText('permissionMode=acceptEdits');

  const bypass = modes.getByRole('radio', { name: 'Bypass' });
  await expect(bypass).toHaveClass(/hc-seg__item--danger/);
  await expect(bypass).toHaveAttribute('title', /without asking/);
  await bypass.click();
  // Applied only after main's confirm (fixture seam approves) arrives as thread:updated.
  await expect(bypass).toHaveAttribute('aria-checked', 'true');
  await sendMessage(page, '[whoami] bypass');
  await expect(messages).toContainText('permissionMode=bypassPermissions');
  const { threads } = (await bootstrapState(page)) as unknown as { threads: { permissionMode: string }[] };
  expect(threads[0].permissionMode).toBe('bypassPermissions');
  await screenshot(page, '16-permission-bypass');

  await modes.getByRole('radio', { name: 'Default' }).click();
  await expect(modes.getByRole('radio', { name: 'Default' })).toHaveAttribute('aria-checked', 'true');
});

test('a pending permission card survives a renderer reload', async () => {
  const { page } = run;
  await sendMessage(page, 'Please update the README greeting');
  await expect(page.locator('.hc-permission')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('statusline')).toContainText('/3 avail');
  await page.getByTestId('sidebar').locator('.hc-thread').first().click();
  const permission = page.locator('.hc-permission');
  await expect(permission).toBeVisible();
  await permission.getByRole('button', { name: 'Allow', exact: true }).click();
  await expect(permission).toHaveCount(0);
  await expect(page.locator('.hc-messages')).toContainText('Done. The greeting now says "Hello Hopecode".');
});

test('thread rename (context menu) and delete; a dirty worktree asks before a forced delete', async () => {
  const { page } = run;
  const sidebar = page.getByTestId('sidebar');
  const rows = sidebar.locator('.hc-thread-wrap');
  await expect(rows).toHaveCount(1);
  // File > New Thread (⌘N) through the menu creates exactly one thread.
  await menuShortcut(run.app, 'CmdOrCtrl+N');
  await expect(rows).toHaveCount(2);
  await page.waitForTimeout(300);
  await expect(rows).toHaveCount(2);

  // Rename the first thread via right-click.
  await rows.nth(0).locator('.hc-thread').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  const input = sidebar.getByRole('textbox', { name: 'Thread name' });
  await input.fill('Renamed thread');
  await input.press('Enter');
  await expect(rows.nth(0).locator('.hc-thread__title')).toHaveText('Renamed thread');
  const afterRename = await bootstrapState(page);
  expect(afterRename.threads.map((t) => t.title)).toContain('Renamed thread');
  await screenshot(page, '17-thread-renamed');

  // Make the second thread's worktree dirty, then delete it via the hover menu.
  const second = afterRename.threads.find((t) => t.title !== 'Renamed thread')!;
  writeFileSync(join(second.cwd, 'scratch.txt'), 'uncommitted\n');
  await rows.nth(1).hover();
  await rows.nth(1).locator('.hc-thread__more').click();
  await page.getByRole('menuitem', { name: 'Delete…' }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete thread' });
  await confirm.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(confirm).toContainText('uncommitted changes');
  await expect(rows).toHaveCount(2);
  await screenshot(page, '18-thread-delete-dirty');
  await confirm.getByRole('button', { name: 'Force Delete' }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first().locator('.hc-thread__title')).toHaveText('Renamed thread');
  expect(existsSync(second.cwd)).toBe(false);
  expect((await bootstrapState(page)).threads).toHaveLength(1);
});

test('terminal: shell exit shows Restart, which starts a new shell', async () => {
  const { page } = run;
  await page.getByTestId('sidebar').locator('.hc-thread').first().click();
  const app = page.locator('.app');
  if (!(await app.getAttribute('class'))?.includes('app--terminal-open')) await menuShortcut(run.app, 'CmdOrCtrl+J');
  await expect(app).toHaveClass(/app--terminal-open/);
  const terminal = page.getByTestId('terminal');
  await terminal.locator('.xterm').click();
  await page.keyboard.type('exit\n');
  const exited = terminal.locator('.app__terminal-exited');
  await expect(exited).toContainText('Shell exited', { timeout: 20_000 });
  await screenshot(page, '19-terminal-exited');

  await exited.getByRole('button', { name: 'Restart' }).click();
  await expect(exited).toHaveCount(0);
  await terminal.locator('.xterm').click();
  await page.keyboard.type('echo "AGAIN=[$((40+2))]"\n');
  await expect
    .poll(async () => ((await terminal.locator('.xterm-rows').textContent()) ?? '').replace(/\s+/g, ''), { timeout: 20_000 })
    .toContain('AGAIN=[42]');
  await menuShortcut(run.app, 'CmdOrCtrl+J');
  await expect(app).toHaveClass(/app--terminal-closed/);
});

test('project trust: untrusted badge and Trust / Revoke from the project menu', async () => {
  const { page } = run;
  const sidebar = page.getByTestId('sidebar');
  const badge = sidebar.getByRole('button', { name: 'Untrusted: repo .claude settings disabled' });
  const openMenu = () => sidebar.locator('.hc-project__header').first().click({ button: 'right' });

  if ((await badge.count()) === 0) {
    await openMenu();
    await page.getByRole('menuitem', { name: 'Revoke Trust' }).click();
  }
  await expect(badge).toBeVisible();
  await expect(badge).toHaveAttribute('title', /Untrusted: repo \.claude settings disabled/);
  expect(((await bootstrapState(page)) as unknown as { projects: { trusted: boolean }[] }).projects[0].trusted).toBe(false);
  await screenshot(page, '20-project-untrusted');

  await openMenu();
  await page.getByRole('menuitem', { name: 'Trust Project' }).click();
  await expect(badge).toHaveCount(0);
  expect(((await bootstrapState(page)) as unknown as { projects: { trusted: boolean }[] }).projects[0].trusted).toBe(true);
});
