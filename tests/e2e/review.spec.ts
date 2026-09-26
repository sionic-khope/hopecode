// Review-fix coverage: H2 한글 IME Enter, L10 thread rename / delete (+ dirty worktree force), M8 terminal
// exit -> Restart, project trust badge, T5 permission modes reaching the session, M7 permission card survives
// a renderer reload.
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import {
  bottomTerminal,
  bootstrapState,
  chooseFixtureFolder,
  createSandbox,
  launch,
  menuShortcut,
  screenshot,
  sendMessage,
  startThread,
  type Launched,
  type Sandbox,
} from './helpers';

test.describe.configure({ mode: 'serial' });

let sandbox: Sandbox;
let run: Launched;

test.beforeAll(async () => {
  sandbox = createSandbox();
  run = await launch(sandbox);
  // The launch screen is a draft: pick the folder so the first Enter below starts the thread.
  await chooseFixtureFolder(run.page, sandbox);
});

test.afterAll(async () => {
  await run?.app.close();
  sandbox?.cleanup();
});

test('한글 IME: Enter that commits a composition does not send (or start the draft); the next Enter does', async () => {
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
  expect((await bootstrapState(page)).threads).toHaveLength(0);

  await box.press('Enter');
  await expect(page.locator('.hc-msg-user__bubble')).toHaveText('[text] 안녕하세요');
  await expect(box).toHaveValue('');
  await expect(page.locator('.hc-messages')).toContainText('Streaming reply from the fixture session.');
});

test('permission modes: 계획 / 편집 자동 승인 reach the next turn; 전체 액세스 goes through the confirm seam', async () => {
  const { page } = run;
  const chip = page.locator('.hc-composer .hc-chip--perm');
  const messages = page.locator('.hc-messages');
  const pick = async (label: string) => {
    await chip.click();
    await page.getByRole('menu', { name: '권한' }).getByRole('menuitemradio', { name: new RegExp(`^${label}`) }).click();
  };

  await pick('계획');
  await expect(chip).toHaveText(/계획/);
  await sendMessage(page, '[whoami] plan');
  await expect(messages).toContainText('permissionMode=plan');

  await pick('편집 자동 승인');
  await expect(chip).toHaveText(/편집 자동 승인/);
  await sendMessage(page, '[whoami] acceptEdits');
  await expect(messages).toContainText('permissionMode=acceptEdits');

  await chip.click();
  const bypass = page.getByRole('menu', { name: '권한' }).getByRole('menuitemradio', { name: /^전체 액세스/ });
  await expect(bypass).toHaveClass(/hc-mnu__item--warn/);
  await expect(bypass).toContainText('묻지 않고');
  await bypass.click();
  // Applied only after main's confirm (fixture seam approves) arrives as thread:updated.
  await expect(chip).toHaveText(/전체 액세스/);
  await expect(chip).toHaveClass(/hc-chip--warn/);
  await sendMessage(page, '[whoami] bypass');
  await expect(messages).toContainText('permissionMode=bypassPermissions');
  const { threads } = await bootstrapState(page);
  expect(threads[0].permissionMode).toBe('bypassPermissions');
  await screenshot(page, '16-permission-bypass');

  await pick('기본');
  await expect(chip).toHaveText(/기본/);
});

test('a pending permission card survives a renderer reload', async () => {
  const { page } = run;
  await sendMessage(page, 'Please update the README greeting');
  await expect(page.locator('.hc-permission')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('statusline')).toContainText('/3 avail');
  // A reload lands on a new chat (draft); the thread is one click away.
  await expect(page.getByTestId('draft')).toBeVisible();
  await page.getByTestId('sidebar').locator('.hc-thread').first().click();
  const permission = page.locator('.hc-permission');
  await expect(permission).toBeVisible();
  await permission.getByRole('button', { name: '허용', exact: true }).click();
  await expect(permission).toHaveCount(0);
  await expect(page.locator('.hc-messages')).toContainText('Done. The greeting now says "Hello Hopecode".');
});

test('thread rename (context menu) and delete; a dirty worktree asks before a forced delete', async () => {
  const { page } = run;
  const sidebar = page.getByTestId('sidebar');
  const rows = sidebar.locator('.hc-thread-wrap');
  await expect(rows).toHaveCount(1);
  // File > 새 채팅 (⌘N) only opens a draft: no thread exists until its first message.
  await menuShortcut(run.app, 'CmdOrCtrl+N');
  await expect(page.getByTestId('draft')).toBeVisible();
  await page.waitForTimeout(300);
  await expect(rows).toHaveCount(1);
  await startThread(page, sandbox, '[text] second thread');
  await expect(rows).toHaveCount(2);

  // Rename the older thread via right-click.
  const older = rows.filter({ hasNotText: 'second thread' });
  await older.locator('.hc-thread').click({ button: 'right' });
  await page.getByRole('menuitem', { name: '이름 변경' }).click();
  const input = sidebar.getByRole('textbox', { name: '스레드 이름' });
  await input.fill('Renamed thread');
  await input.press('Enter');
  await expect(sidebar.locator('.hc-thread__title').filter({ hasText: 'Renamed thread' })).toHaveCount(1);
  const afterRename = await bootstrapState(page);
  expect(afterRename.threads.map((t) => t.title)).toContain('Renamed thread');
  await screenshot(page, '17-thread-renamed');

  // Make the second thread's worktree dirty, then delete it via its context menu.
  const second = afterRename.threads.find((t) => t.title !== 'Renamed thread')!;
  writeFileSync(join(second.cwd, 'scratch.txt'), 'uncommitted\n');
  const secondRow = rows.filter({ hasText: 'second thread' });
  await secondRow.locator('.hc-thread').click({ button: 'right' });
  await page.getByRole('menuitem', { name: '삭제…' }).click();
  const confirm = page.getByRole('dialog', { name: '스레드 삭제' });
  await confirm.getByRole('button', { name: '삭제', exact: true }).click();
  await expect(confirm).toContainText('커밋하지 않은 변경 사항');
  await expect(rows).toHaveCount(2);
  await screenshot(page, '18-thread-delete-dirty');
  await confirm.getByRole('button', { name: '강제 삭제' }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first().locator('.hc-thread__title')).toHaveText('Renamed thread');
  expect(existsSync(second.cwd)).toBe(false);
  expect((await bootstrapState(page)).threads).toHaveLength(1);
});

test('terminal: shell exit shows 다시 시작, which starts a new shell', async () => {
  const { page } = run;
  await page.getByTestId('sidebar').locator('.hc-thread').first().click();
  const app = page.locator('.app');
  if (!(await app.getAttribute('class'))?.includes('app--terminal-open')) await menuShortcut(run.app, 'CmdOrCtrl+J');
  await expect(app).toHaveClass(/app--terminal-open/);
  const terminal = bottomTerminal(page);
  await terminal.locator('.xterm').click();
  await page.keyboard.type('exit\n');
  const exited = terminal.locator('.app__terminal-exited');
  await expect(exited).toContainText('셸이 종료되었습니다', { timeout: 20_000 });
  await screenshot(page, '19-terminal-exited');

  await exited.getByRole('button', { name: '다시 시작' }).click();
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
  const badge = sidebar.getByRole('button', { name: '신뢰하지 않음: 저장소 .claude 설정 비활성' });
  const openMenu = () => sidebar.locator('.hc-project__header').first().click({ button: 'right' });

  if ((await badge.count()) === 0) {
    await openMenu();
    await page.getByRole('menuitem', { name: '신뢰 해제' }).click();
  }
  await expect(badge).toBeVisible();
  await expect(badge).toHaveAttribute('title', /신뢰하지 않음: 저장소 \.claude 설정 비활성/);
  expect(((await bootstrapState(page)) as unknown as { projects: { trusted: boolean }[] }).projects[0].trusted).toBe(false);
  await screenshot(page, '20-project-untrusted');

  await openMenu();
  await page.getByRole('menuitem', { name: '프로젝트 신뢰' }).click();
  await expect(badge).toHaveCount(0);
  expect(((await bootstrapState(page)) as unknown as { projects: { trusted: boolean }[] }).projects[0].trusted).toBe(true);
});
