// T1 project/thread, T2 worktree under HOPECODE_HOME, T3 streaming + tool card, T4 diff, T5 permission card,
// T6 per-thread model, U1 ctx from getContextUsage, R1 terminal cwd = worktree.
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
});

test.afterAll(async () => {
  await run?.app.close();
  sandbox?.cleanup();
});

test('add project (dialog seam) -> group -> thread in a git worktree under HOPECODE_HOME', async () => {
  const { page } = run;
  await addProjectAndThread(page);
  const sidebar = page.getByTestId('sidebar');
  await expect(sidebar.locator('.hc-project__name')).toHaveText(sandbox.project.split('/').pop()!);
  // Expanded group: chevron is not in the collapsed (pointing right) state.
  await expect(sidebar.locator('.hc-project__chevron')).not.toHaveClass(/hc-project__chevron--collapsed/);

  const { threads } = await bootstrapState(page);
  expect(threads).toHaveLength(1);
  expect(threads[0].cwd.startsWith(`${sandbox.home}/home/worktrees/`)).toBe(true);
  await screenshot(page, '04-thread-created');
});

test('send: streaming text, Edit tool card, permission Allow, diff lines, ctx from getContextUsage', async () => {
  const { page } = run;
  await sendMessage(page, 'Please update the README greeting');

  const messages = page.locator('.hc-messages');
  await expect(messages.locator('.hc-msg-user__bubble')).toHaveText('Please update the README greeting');
  await expect(messages).toContainText('I will update the README greeting.');

  const permission = page.locator('.hc-permission');
  await expect(permission).toBeVisible();
  await expect(permission).toContainText('Edit');
  await screenshot(page, '05-permission-card');
  await permission.getByRole('button', { name: 'Allow', exact: true }).click();
  await expect(permission).toHaveCount(0);

  await expect(messages).toContainText('Done. The greeting now says "Hello Hopecode".');
  const tool = messages.locator('.hc-tool').filter({ hasText: 'Edit' });
  await expect(tool.locator('.hc-tool__status--ok')).toBeVisible();
  await tool.locator('.hc-tool__header').click();
  await expect(tool.locator('.hc-diff__row--del')).toContainText('Hello world');
  await expect(tool.locator('.hc-diff__row--add')).toContainText('Hello Hopecode');

  const ctx = page.getByTestId('statusline').locator('.hc-meter').filter({ hasText: 'ctx' });
  await expect(ctx.locator('.hc-meter__percent')).toHaveText('31%');
  await screenshot(page, '06-chat-diff');
});

test('per-thread model selection reaches the session', async () => {
  const { page } = run;
  await page.locator('.hc-toolbar .hc-picker').first().click();
  await page.getByRole('option', { name: /Sonnet/ }).click();
  await expect(page.locator('.hc-toolbar .hc-picker').first()).toContainText('Sonnet');
  await sendMessage(page, '[whoami] model check');
  await expect(page.locator('.hc-messages')).toContainText('model=sonnet');
});

test('terminal opens a shell in the thread worktree', async () => {
  const { page } = run;
  const { threads } = await bootstrapState(page);
  await menuShortcut(run.app, 'CmdOrCtrl+J');
  const term = page.getByTestId('terminal').locator('.xterm');
  await expect(term).toBeVisible();
  await term.click();
  await page.keyboard.type('echo "CWD=[$(pwd -P)]"\n');
  // macOS tmpdir is a /var -> /private/var symlink; compare on the worktree-relative tail.
  const tail = threads[0].cwd.slice(threads[0].cwd.indexOf('/home/worktrees/'));
  const rows = page.getByTestId('terminal').locator('.xterm-rows');
  // The output line (not the echoed command) reads `CWD=[/private/var/.../home/worktrees/<slug>/<id>]`.
  await expect
    .poll(async () => ((await rows.textContent()) ?? '').replace(/\s+/g, ''), { timeout: 20_000 })
    .toContain(`${tail}]`);
  await screenshot(page, '07-terminal-cwd');
});
