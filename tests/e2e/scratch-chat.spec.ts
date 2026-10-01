// Chats without a project (plan 2.12, AC11): sending with no folder starts in an app-managed scratch folder
// ($HOPECODE_HOME/home/scratch/<threadId>, no git, no worktree), listed under the sidebar's "채팅" section, with
// git features replaced by "폴더 열기", the bottom terminal opening in that folder and deletion removing it.
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  bootstrapState,
  bottomTerminal,
  createSandbox,
  launch,
  openDraft,
  pickAgent,
  screenshot,
  sendMessage,
  type Launched,
  type Sandbox,
} from './helpers';

const SHOTS =
  process.env['HOPECODE_REDESIGN_SCREENSHOTS'] ??
  '/private/tmp/claude-501/-Users-khope-sionic-ai-Desktop-khope-hopecode/69735d65-52c2-4ff2-9412-948601635f0d/scratchpad/redesign';

test.describe.configure({ mode: 'serial' });

let sandbox: Sandbox;
let run: Launched;
let claudeId = '';

test.beforeAll(async () => {
  sandbox = createSandbox();
  run = await launch(sandbox);
});

test.afterAll(async () => {
  await run?.app.close();
  sandbox?.cleanup();
});

const scratchDir = (id: string) => join(sandbox.home, 'home', 'scratch', id);
const toolbar = (page: Page) => page.getByRole('toolbar', { name: '스레드 도구' });

test('no folder: sending starts a scratch chat (Claude) listed under 채팅, header says 프로젝트 없음', async () => {
  const { page } = run;
  const draft = page.getByTestId('draft');
  await expect(draft.locator('.hc-chip--folder')).toHaveText(/프로젝트 없음/);
  await sendMessage(page, '[text] 프로젝트 없이 물어볼게요');
  await expect(page.locator('.hc-messages')).toContainText('Streaming reply from the fixture session.');

  const { threads, projects } = await bootstrapState(page);
  expect(projects).toHaveLength(0);
  expect(threads).toHaveLength(1);
  const thread = threads[0];
  claudeId = thread.id;
  expect(thread.projectId).toBeNull();
  expect(thread.worktree).toBeUndefined();
  expect(realpathSync(thread.cwd)).toBe(realpathSync(scratchDir(thread.id)));
  // No git repository is created for a scratch chat.
  expect(existsSync(join(thread.cwd, '.git'))).toBe(false);

  const chats = page.getByTestId('sidebar-chats');
  await expect(chats.locator('.hc-thread')).toHaveCount(1);
  await expect(chats.locator('.hc-thread')).toContainText('프로젝트 없이 물어볼게요');
  await expect(page.locator('.app__thread-project--none')).toHaveText('프로젝트 없음');
  await page.mouse.move(10, 700);
  await screenshot(page, 'v7-scratch-chat', SHOTS);
});

test('git features are replaced by 폴더 열기 (changes panel, 더보기, 환경)', async () => {
  const { page } = run;
  await toolbar(page).getByRole('button', { name: '변경사항 패널' }).click();
  const panel = page.getByTestId('changes-panel');
  await expect(panel).toHaveAttribute('data-scratch', 'true');
  await expect(panel).toContainText('프로젝트 없는 채팅입니다');
  await expect(panel.getByTestId('changes-open-folder')).toHaveText('폴더 열기');
  await expect(panel.locator('.hc-changes__file')).toHaveCount(0);
  await toolbar(page).getByRole('button', { name: '변경사항 패널' }).click();

  await toolbar(page).getByRole('button', { name: '더보기' }).click();
  const more = page.getByRole('menu', { name: '더보기' });
  await expect(more.getByRole('menuitem', { name: '폴더 열기' })).toBeVisible();
  await expect(more.getByRole('menuitem', { name: /에서 열기$/ })).toHaveCount(0);
  await page.keyboard.press('Escape');

  await toolbar(page).getByRole('button', { name: '환경' }).click();
  const env = page.getByRole('dialog', { name: '환경' });
  await expect(env).toContainText('프로젝트 없는 채팅은 git을 사용하지 않아요');
  await expect(env.getByTestId('env-worktree')).toHaveCount(0);
  await page.keyboard.press('Escape');
});

test('the bottom terminal opens in the scratch folder', async () => {
  const { page } = run;
  await toolbar(page).getByRole('button', { name: '하단 터미널' }).click();
  const term = bottomTerminal(page).locator('.xterm');
  await expect(term).toBeVisible();
  await term.click();
  await page.keyboard.type('echo "CWD=[$(pwd -P)]"\n');
  const expected = `CWD=[${realpathSync(scratchDir(claudeId))}]`;
  await expect
    .poll(async () => ((await bottomTerminal(page).locator('.xterm-rows').textContent()) ?? '').replace(/\s+/g, ''), { timeout: 20_000 })
    .toContain(expected.replace(/\s+/g, ''));
  await toolbar(page).getByRole('button', { name: '하단 터미널' }).click();
});

test('Codex scratch chat: the agent runs in its own scratch folder', async () => {
  const { page } = run;
  await openDraft(page);
  await pickAgent(page, 'Codex');
  await expect(page.getByTestId('draft').locator('.hc-chip--folder')).toHaveText(/프로젝트 없음/);
  await sendMessage(page, '/config');
  const reply = page.locator('.hc-messages').getByText(/^CONFIG \{/);
  await expect(reply).toHaveCount(1);
  const body = (await reply.textContent()) ?? '';
  const config = JSON.parse(body.slice(body.indexOf('{'))) as { cwd: string };
  const codex = (await bootstrapState(page)).threads.find((t) => t.id !== claudeId)!;
  expect(codex.projectId).toBeNull();
  expect(realpathSync(config.cwd)).toBe(realpathSync(scratchDir(codex.id)));
  await expect(page.getByTestId('sidebar-chats').locator('.hc-thread')).toHaveCount(2);
});

test('deleting a scratch chat removes its folder', async () => {
  const { page } = run;
  const dir = scratchDir(claudeId);
  expect(existsSync(dir)).toBe(true);
  await page.getByTestId('sidebar-chats').locator('.hc-thread').filter({ hasText: '프로젝트 없이 물어볼게요' }).click();
  await toolbar(page).getByRole('button', { name: '더보기' }).click();
  await page.getByRole('menu', { name: '더보기' }).getByRole('menuitem', { name: '삭제…' }).click();
  const confirm = page.getByRole('dialog', { name: '스레드 삭제' });
  await confirm.getByRole('button', { name: '삭제', exact: true }).click();
  await expect.poll(async () => (await bootstrapState(page)).threads.some((t) => t.id === claudeId)).toBe(false);
  await expect.poll(() => existsSync(dir)).toBe(false);
  await expect(page.getByTestId('sidebar-chats').locator('.hc-thread')).toHaveCount(1);
});
