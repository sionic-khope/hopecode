// v5 top-right window toolbar: composer keeps only chat controls; 더보기 (editor, account pin, rename / pin /
// archive / delete), 공유 (Markdown file via the dialog seam, clipboard), 환경 popover (changes, worktree, branch
// create, commit / PR, subagents, sources), terminal and changes panel toggles in the draft and in a thread.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  bottomTerminal,
  bootstrapState,
  createSandbox,
  launch,
  openDraft,
  screenshot,
  sendMessage,
  startThread,
  type Launched,
  type Sandbox,
} from './helpers';

const SHOTS =
  process.env['HOPECODE_REDESIGN_SCREENSHOTS'] ??
  '/private/tmp/claude-501/-Users-khope-sionic-ai-Desktop-khope-hopecode/69735d65-52c2-4ff2-9412-948601635f0d/scratchpad/redesign';

const TITLE = 'README 인사말을 바꿔 주세요';

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

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const toolbar = (page: Page) => page.getByRole('toolbar', { name: '스레드 도구' });
const envPopover = (page: Page) => page.getByRole('dialog', { name: '환경' });

async function openEnv(page: Page) {
  await toolbar(page).getByRole('button', { name: '환경' }).click();
  await expect(envPopover(page)).toBeVisible();
  return envPopover(page);
}

async function expectComposerWithoutWindowControls(page: Page) {
  const composer = page.locator('.hc-composer');
  await expect(composer).toBeVisible();
  await expect(composer.locator('.hc-chip--account')).toHaveCount(0);
  await expect(composer.getByRole('button', { name: /터미널/ })).toHaveCount(0);
  await expect(composer.getByRole('button', { name: /^계정 고정/ })).toHaveCount(0);
  await expect(composer.getByRole('button', { name: '추가' })).toBeVisible();
  await expect(composer.getByRole('button', { name: /^권한:/ })).toBeVisible();
  await expect(composer.getByRole('button', { name: /^모델:/ })).toBeVisible();
}

test('draft: composer has no terminal / account controls; the top-right bottom-panel toggle opens the draft shell under the chat', async () => {
  const { page } = run;
  await openDraft(page);
  await expectComposerWithoutWindowControls(page);
  await expect(page.getByTestId('draft').locator('.hc-chip--folder')).toBeVisible();

  const bar = toolbar(page);
  await expect(bar).toBeVisible();
  // Thread-only controls wait for the thread.
  await expect(bar.getByRole('button', { name: '공유' })).toBeDisabled();
  await expect(bar.getByRole('button', { name: '환경' })).toBeDisabled();

  const app = page.locator('.app');
  const terminalToggle = bar.getByRole('button', { name: '하단 터미널' });
  await expect(app).toHaveClass(/app--terminal-closed/);
  await expect(terminalToggle).toHaveAttribute('title', '하단 터미널 열기 (⌘J)');
  await terminalToggle.click();
  await expect(app).toHaveClass(/app--terminal-open/);
  await expect(terminalToggle).toHaveAttribute('aria-pressed', 'true');
  await expect(terminalToggle).toHaveAttribute('title', '하단 터미널 닫기 (⌘J)');
  // The right panel stays closed and its toggle stays off: the terminal is not a right-panel tab.
  await expect(app).toHaveClass(/app--panel-closed/);
  await expect(bar.getByRole('button', { name: '변경사항 패널' })).toHaveAttribute('aria-pressed', 'false');
  await expect(bottomTerminal(page).locator('.xterm')).toBeVisible();
  await terminalToggle.click();
  await expect(app).toHaveClass(/app--terminal-closed/);
  await expect(terminalToggle).toHaveAttribute('aria-pressed', 'false');

  // 더보기 in the draft: only the account pin (it applies to the chat about to start).
  await bar.getByRole('button', { name: '더보기' }).click();
  const menu = page.getByRole('menu', { name: '더보기' });
  await expect(menu.getByRole('group', { name: '계정 고정' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: '스레드 이름 변경' })).toHaveCount(0);
  await page.keyboard.press('Escape');
});

test('thread: toolbar order, terminal and changes toggles', async () => {
  const { page } = run;
  await startThread(page, sandbox, TITLE);
  await page.locator('.hc-permission').getByRole('button', { name: '허용', exact: true }).click();
  await expect(page.locator('.hc-messages')).toContainText('Done. The greeting now says "Hello Hopecode".');
  await expectComposerWithoutWindowControls(page);

  const bar = toolbar(page);
  const names = await bar.getByRole('button').evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')));
  expect(names).toEqual(['더보기', '공유', '환경', '하단 터미널', '변경사항 패널']);

  const app = page.locator('.app');
  const terminalToggle = bar.getByRole('button', { name: '하단 터미널' });
  await terminalToggle.click();
  await expect(app).toHaveClass(/app--terminal-open/);
  await expect(bottomTerminal(page).locator('.xterm')).toBeVisible();
  await terminalToggle.click();
  await expect(app).toHaveClass(/app--terminal-closed/);

  const changesToggle = bar.getByRole('button', { name: '변경사항 패널' });
  await changesToggle.click();
  await expect(page.getByTestId('changes-panel')).toBeVisible();
  await expect(changesToggle).toHaveAttribute('aria-pressed', 'true');
  await changesToggle.click();
  await expect(app).toHaveClass(/app--panel-closed/);
  await page.mouse.move(10, 700);
  await screenshot(page, 'v5-toolbar', SHOTS);
});

test('env popover: change counts from git:changes, click opens the changes tab', async () => {
  const { page } = run;
  const env = await openEnv(page);
  const changes = env.getByRole('button', { name: /^변경 사항/ });
  // The fixture Edit: README.md "Hello world" -> "Hello Hopecode".
  await expect(changes).toHaveAccessibleName('변경 사항 +1 -1');
  await expect(env.getByTestId('env-changes-stat')).toHaveText('+1−1');
  await changes.click();
  await expect(envPopover(page)).toHaveCount(0);
  await expect(page.getByTestId('changes-panel')).toBeVisible();
  await expect(page.locator('.hc-panel__title')).toHaveText('변경사항');
  await expect(page.locator('.app__panel').getByRole('radio')).toHaveCount(0);
  await expect(page.getByTestId('changes-panel').locator('.hc-changes__file[data-path="README.md"]')).toBeVisible();
  await toolbar(page).getByRole('button', { name: '변경사항 패널' }).click();
});

test('env popover: subagents and sources from a [sources] turn; both jump to their target', async () => {
  const { page } = run;
  await sendMessage(page, '[sources] 구조를 살펴봐 주세요 @README.md');
  await expect(page.locator('.hc-messages')).toContainText('The repository has one README.');

  const env = await openEnv(page);
  await expect(env.getByRole('heading', { name: /하위 에이전트/ })).toBeVisible();
  await expect(env.getByTestId('env-subagents-summary')).toHaveText('완료 1');
  const agentRow = env.getByRole('button', { name: /저장소 구조 조사/ });
  await expect(agentRow).toContainText('general-purpose');
  await expect(agentRow).toContainText('완료');
  await expect(env.locator('.hc-env__avatar .hc-sprite')).toHaveCount(1);

  await expect(env.getByRole('heading', { name: '소스' })).toBeVisible();
  const readme = env.locator('.hc-env__row[data-path="README.md"]');
  // Mentioned, read (absolute path) and edited: one row.
  await expect(readme).toHaveCount(1);
  await expect(readme).toContainText('읽음');
  await expect(readme).toContainText('첨부');
  await expect(readme).toContainText('편집');
  await page.mouse.move(10, 700);
  await screenshot(page, 'v5-env-popover', SHOTS);

  // Subagent row -> its card in the transcript (same data-tool-id anchor as tool cards), scrolled into view.
  await page.locator('.hc-messages').evaluate((el) => (el.scrollTop = 0));
  await agentRow.click();
  await expect(envPopover(page)).toHaveCount(0);
  const card = page.locator('[data-tool-id]').filter({ hasText: '저장소 구조 조사' }).first();
  await expect(card).toHaveAttribute('data-tool-id', /toolu_/);
  await expect(card).toBeInViewport();

  // Changed source -> changes tab with that file's diff open.
  const env2 = await openEnv(page);
  await env2.locator('.hc-env__row[data-path="README.md"]').click();
  const file = page.getByTestId('changes-panel').locator('.hc-changes__file[data-path="README.md"]');
  await expect(file).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('changes-panel').locator('.hc-diff__row--add')).toContainText('Hello Hopecode');
  await toolbar(page).getByRole('button', { name: '변경사항 패널' }).click();

  // The editor shortcut beside a changed source opens it (fixture launcher records, nothing launches).
  const env3 = await openEnv(page);
  await env3.getByRole('button', { name: /^README\.md .*에서 열기$/ }).click();
  await expect(envPopover(page)).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('env popover: worktree details and 브랜치 생성 switches the worktree branch', async () => {
  const { page } = run;
  const thread = (await bootstrapState(page)).threads.find((t) => t.title === TITLE)!;
  const env = await openEnv(page);
  await env.getByRole('button', { name: /작업 트리/ }).click();
  const tree = env.getByTestId('env-worktree');
  await expect(tree).toContainText(thread.worktree!.branch);
  await expect(tree).toContainText('main');
  await expect(tree).toContainText(thread.worktree!.path.split('/').pop()!);
  await tree.getByRole('button', { name: 'Finder에서 열기' }).click();
  await expect(env.getByRole('alert')).toHaveCount(0);

  await env.getByRole('button', { name: '브랜치 생성' }).click();
  const form = env.getByRole('form', { name: '브랜치 생성' });
  const input = form.getByRole('textbox', { name: '새 브랜치 이름' });
  await input.fill('bad name..');
  await expect(form.getByRole('alert')).toBeVisible();
  await expect(form.getByRole('button', { name: '만들기' })).toBeDisabled();
  await input.fill('feature/toolbar-e2e');
  await form.getByRole('button', { name: '만들기' }).click();
  await expect(form.getByRole('status')).toContainText('feature/toolbar-e2e');
  expect(git(thread.worktree!.path, 'symbolic-ref', '--short', 'HEAD')).toBe('feature/toolbar-e2e');
  // Uncommitted work comes along; the project folder keeps its branch.
  expect(git(thread.worktree!.path, 'status', '--porcelain')).toContain('README.md');
  expect(git(sandbox.project, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
  // The popover follows the checked-out branch.
  await expect(env.getByRole('button', { name: /작업 트리/ })).toContainText('feature/toolbar-e2e');

  // An existing name is refused by main.
  await input.fill('main');
  await form.getByRole('button', { name: '만들기' }).click();
  await expect(form.getByRole('alert')).toContainText('이미 있는 브랜치입니다');
  expect(git(thread.worktree!.path, 'symbolic-ref', '--short', 'HEAD')).toBe('feature/toolbar-e2e');
  await page.keyboard.press('Escape');
});

test('share: Markdown export through the save-dialog seam, and clipboard copy', async () => {
  const { page, app } = run;
  const bar = toolbar(page);
  await bar.getByRole('button', { name: '공유' }).click();
  await page.getByRole('menu', { name: '공유' }).getByRole('menuitem', { name: /Markdown으로 내보내기/ }).click();
  await expect(bar.getByRole('status')).toHaveText('Markdown 파일로 저장했습니다');
  // Fixture save dialog: $HOPECODE_HOME/home/exports/<title>.md.
  const file = join(sandbox.home, 'home', 'exports', `${TITLE}.md`);
  expect(existsSync(file)).toBe(true);
  const text = readFileSync(file, 'utf8');
  expect(text.startsWith(`# ${TITLE}\n`)).toBe(true);
  expect(text).toContain(`## 사용자\n\n${TITLE}`);
  expect(text).toContain('I will update the README greeting.');
  expect(text).toContain('- 도구 **Edit** `README.md` (완료)');
  expect(text).toContain('- 도구 **Task** `general-purpose · 저장소 구조 조사` (완료)');
  expect(text).toContain('## 사용자\n\n[sources] 구조를 살펴봐 주세요 @README.md');

  await app.evaluate(({ clipboard }) => clipboard.writeText(''));
  await bar.getByRole('button', { name: '공유' }).click();
  await page.getByRole('menu', { name: '공유' }).getByRole('menuitem', { name: /Markdown 복사/ }).click();
  await expect(bar.getByRole('status')).toHaveText('Markdown을 클립보드에 복사했습니다');
  const copied = await app.evaluate(({ clipboard }) => clipboard.readText());
  expect(copied.startsWith(`# ${TITLE}\n`)).toBe(true);
  expect(copied).toContain('- 도구 **Read**');
  expect(copied).toContain('The repository has one README.');
});

test('더보기: editor, account pin, rename, pin, archive and delete (with its confirmation)', async () => {
  const { page } = run;
  const bar = toolbar(page);
  const more = bar.getByRole('button', { name: '더보기' });
  const menu = page.getByRole('menu', { name: '더보기' });
  // The share confirmation from the previous test fades first (clean capture).
  await expect(bar.getByRole('status')).toHaveCount(0, { timeout: 6_000 });
  await more.click();
  await expect(menu.getByRole('group', { name: '에디터에서 열기' }).getByRole('menuitem').first()).toBeVisible();
  await expect(menu.getByRole('group', { name: '계정 고정' }).getByRole('menuitemradio', { name: /^자동/ })).toHaveAttribute('aria-checked', 'true');
  await page.mouse.move(10, 700);
  await screenshot(page, 'v5-more-menu', SHOTS);

  // Account pin -> the thread record.
  await menu.getByRole('menuitemradio', { name: /^Spare/ }).click();
  await expect.poll(async () => (await bootstrapState(page)).threads.find((t) => t.title === TITLE) as unknown as { pinnedAccountId: string | null })
    .toMatchObject({ pinnedAccountId: 'fixture-spare' });

  // Open in the first editor (fixture launcher records it).
  await more.click();
  await menu.getByRole('group', { name: '에디터에서 열기' }).getByRole('menuitem').first().click();
  await expect(page.getByRole('alert')).toHaveCount(0);

  // Rename.
  await more.click();
  await menu.getByRole('menuitem', { name: '스레드 이름 변경' }).click();
  const rename = page.getByRole('textbox', { name: '스레드 이름' });
  await expect(rename).toBeFocused();
  await rename.fill('툴바 테스트 스레드');
  await rename.press('Enter');
  await expect(page.locator('.app__thread-name')).toHaveText('툴바 테스트 스레드');

  // Pin / archive.
  await more.click();
  await menu.getByRole('menuitem', { name: '고정', exact: true }).click();
  await expect.poll(async () => (await bootstrapState(page)).threads.find((t) => t.title === '툴바 테스트 스레드')?.pinned).toBe(true);
  await more.click();
  await menu.getByRole('menuitem', { name: '보관', exact: true }).click();
  await expect.poll(async () => (await bootstrapState(page)).threads.find((t) => t.title === '툴바 테스트 스레드')?.archived).toBe(true);
  await expect(page.getByTestId('draft')).toBeVisible();

  // Delete another thread through the confirmation (dirty worktree -> force step).
  await startThread(page, sandbox, '[text] 삭제할 스레드');
  const { threads } = await bootstrapState(page);
  const doomed = threads.find((t) => t.title === '[text] 삭제할 스레드')!;
  execFileSync('sh', ['-c', 'echo dirty > scratch.txt'], { cwd: doomed.worktree!.path });
  await more.click();
  await menu.getByRole('menuitem', { name: '삭제…' }).click();
  const confirm = page.getByRole('dialog', { name: '스레드 삭제' });
  await expect(confirm).toContainText('[text] 삭제할 스레드');
  await confirm.getByRole('button', { name: '삭제', exact: true }).click();
  await expect(confirm).toContainText('커밋하지 않은 변경 사항');
  await confirm.getByRole('button', { name: '강제 삭제' }).click();
  await expect.poll(async () => (await bootstrapState(page)).threads.some((t) => t.id === doomed.id)).toBe(false);
  expect(existsSync(doomed.worktree!.path)).toBe(false);
});
